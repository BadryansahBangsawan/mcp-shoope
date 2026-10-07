import { applyShopeeBrowserHeaders, SHOPEE_HTML_ACCEPT } from "../dispatcher/client-headers";
import { sha256Hex } from "../session/crypto";
import type { PendingAuthDraft, PendingAuthState, StoredCookie } from "../session/types";
import { CookieJar, SESSION_COOKIE_NAMES } from "./cookie-jar";
import {
  extractCsrfFromHtml,
  isCaptchaHint,
  isOtpHint,
  isPrintableToken,
  isSuccessError,
  isValidOtp,
  looksLikeHtml,
  normalizeUsername,
  parseLoginJson,
} from "./login-parse";

/**
 * Documented-not-executed buyer login hops (session-only; model never calls these).
 * URLs are required so Connect can run; they are not exposed operations.
 */
export const ORIGIN = "https://shopee.co.id";
export const LOGIN_PAGE_URL = "https://shopee.co.id/buyer/login";
export const LOGIN_URL = "https://shopee.co.id/api/v2/authentication/login";
export const RESEND_OTP_URL = "https://shopee.co.id/api/v2/authentication/resend_otp";
export const VCODE_LOGIN_URL = "https://shopee.co.id/api/v2/authentication/vcode_login";

const FETCH_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type LoginFlowResult =
  | {
      kind: "connected";
      cookies: StoredCookie[];
      csrfToken?: string;
      userId?: string;
    }
  | {
      kind: "needs_otp";
      pending: PendingAuthDraft;
      message?: string;
    }
  | { kind: "needs_paste"; reason: string }
  | { kind: "error"; message: string; status?: number };

/**
 * Default fetch. Never store the global fetch on an object and call it as a
 * method: workerd throws "Illegal invocation" when `this` is not globalThis.
 */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  return fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

export interface LoginFlowInput {
  username: string;
  password: string;
  fetchImpl?: FetchLike;
}

export async function runShopeeLoginFlow(input: LoginFlowInput): Promise<LoginFlowResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const username = normalizeUsername(input.username);
  if (!username) return { kind: "error", message: "Username (HP atau email) wajib diisi" };
  if (!input.password) return { kind: "error", message: "Password wajib diisi" };

  const jar = new CookieJar();
  const pageUrl = new URL(LOGIN_PAGE_URL);
  const pageHeaders = new Headers();
  pageHeaders.set("accept", SHOPEE_HTML_ACCEPT);
  pageHeaders.set("origin", ORIGIN);
  pageHeaders.set("referer", `${ORIGIN}/`);
  applyShopeeBrowserHeaders(pageHeaders, "html");
  const pageRes = await timedFetch(fetchImpl, LOGIN_PAGE_URL, {
    method: "GET",
    headers: pageHeaders,
  });
  jar.applyResponse(pageUrl, pageRes.headers);
  const pageBody = await pageRes.text();

  if (pageRes.status >= 300 || pageRes.status === 403) {
    return {
      kind: "needs_paste",
      reason: `Login gagal (${pageRes.status}).`,
    };
  }
  if (pageRes.status !== 200) {
    return { kind: "error", message: `Login gagal (${pageRes.status}).`, status: pageRes.status };
  }
  if (isCaptchaHint(pageRes.status, null, "", pageBody)) {
    return { kind: "needs_paste", reason: "Login gagal." };
  }

  const csrf = csrfTokenFrom(jar, pageBody);
  if (!csrf) {
    return { kind: "needs_paste", reason: "Login gagal." };
  }

  const passwordHash = await sha256Hex(input.password);
  const loginRes = await postAuthJson(fetchImpl, jar, csrf, LOGIN_URL, {
    username,
    password: passwordHash,
    support_ivs: true,
  });
  return resolveAuthResponse(jar, username, loginRes);
}

export async function continueWithOtp(input: {
  pending: PendingAuthState;
  vcode: string;
  fetchImpl?: FetchLike;
}): Promise<LoginFlowResult> {
  const vcode = input.vcode.trim();
  if (!isValidOtp(vcode)) return { kind: "error", message: "OTP harus 4–8 karakter alfanumerik" };
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const jar = CookieJar.fromJSON(input.pending.cookies);
  const csrf = input.pending.csrfToken ?? csrfTokenFrom(jar);
  if (!csrf) {
    return { kind: "needs_paste", reason: "Login gagal. Masuk ulang." };
  }
  const res = await postAuthJson(fetchImpl, jar, csrf, VCODE_LOGIN_URL, {
    username: input.pending.username,
    vcode,
    support_ivs: true,
  });
  const result = await resolveAuthResponse(jar, input.pending.username, res);
  if (result.kind === "needs_otp") {
    return { kind: "error", message: "OTP salah atau masih diminta. Masuk ulang." };
  }
  return result;
}

export async function resendOtp(input: {
  pending: PendingAuthState;
  fetchImpl?: FetchLike;
}): Promise<LoginFlowResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const jar = CookieJar.fromJSON(input.pending.cookies);
  const csrf = input.pending.csrfToken ?? csrfTokenFrom(jar);
  if (!csrf) {
    return { kind: "needs_paste", reason: "Login gagal. Masuk ulang." };
  }
  const res = await postAuthJson(fetchImpl, jar, csrf, RESEND_OTP_URL, {
    username: input.pending.username,
    support_ivs: true,
  });
  // Success without SPC_EC/SPC_ST still means "OTP resent" — keep pending, do not paste.
  return resolveAuthResponse(jar, input.pending.username, res, "otp");
}

function csrfTokenFrom(jar: CookieJar, html?: string): string | undefined {
  const fromCookie = jar.get(new URL(ORIGIN), "csrftoken");
  if (fromCookie && isPrintableToken(fromCookie)) return fromCookie;
  if (html) {
    const fromHtml = extractCsrfFromHtml(html);
    if (fromHtml) return fromHtml;
  }
  return undefined;
}

function authHeaders(jar: CookieJar, csrf: string, url: string): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("accept", "application/json");
  h.set("origin", ORIGIN);
  h.set("referer", LOGIN_PAGE_URL);
  applyShopeeBrowserHeaders(h, "xhr");
  h.set("x-csrftoken", csrf);
  const cookie = jar.headerFor(new URL(url));
  if (cookie) h.set("cookie", cookie);
  return h;
}

async function postAuthJson(
  fetchImpl: FetchLike,
  jar: CookieJar,
  csrf: string,
  url: string,
  body: object,
): Promise<Response> {
  const res = await timedFetch(fetchImpl, url, {
    method: "POST",
    headers: authHeaders(jar, csrf, url),
    body: JSON.stringify(body),
  });
  jar.applyResponse(new URL(url), res.headers);
  return res;
}

async function resolveAuthResponse(
  jar: CookieJar,
  username: string,
  res: Response,
  noSession: "paste" | "otp" = "paste",
): Promise<LoginFlowResult> {
  const text = await res.text();
  if (isCaptchaHint(res.status, null, "", text) || (res.status === 403 && looksLikeHtml(text))) {
    return { kind: "needs_paste", reason: "Login gagal." };
  }
  if (res.status === 429) {
    return { kind: "error", message: "Shopee membatasi percobaan masuk. Coba lagi nanti.", status: 429 };
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (looksLikeHtml(text)) {
      return { kind: "needs_paste", reason: "Login gagal." };
    }
    return { kind: "error", message: "Login gagal.", status: res.status };
  }

  const parsed = parseLoginJson(json);
  if (isCaptchaHint(res.status, parsed.error, parsed.message, text)) {
    return { kind: "needs_paste", reason: parsed.message || "Login gagal." };
  }
  // Only error + message. Scanning the raw body matches keys like `"ivs"` on password failures.
  if (isOtpHint(parsed.error, parsed.message)) {
    return needsOtp(jar, username, parsed.message || "Shopee meminta kode OTP.");
  }
  if (isSuccessError(parsed.error) && hasSessionCookies(jar)) {
    return connectedFrom(jar);
  }
  if (isSuccessError(parsed.error) && !hasSessionCookies(jar)) {
    if (noSession === "otp") {
      return needsOtp(jar, username, parsed.message || "OTP dikirim ulang. Masukkan kode.");
    }
    return {
      kind: "needs_paste",
      reason: "Login gagal.",
    };
  }
  return {
    kind: "error",
    message: parsed.message || "Login Shopee gagal",
    status: res.status,
  };
}

function hasSessionCookies(jar: CookieJar): boolean {
  const url = new URL(ORIGIN);
  return SESSION_COOKIE_NAMES.some((name) => Boolean(jar.get(url, name)));
}

function connectedFrom(jar: CookieJar): LoginFlowResult {
  const url = new URL(ORIGIN);
  const uid = jar.get(url, "SPC_U");
  const userId = uid && /^\d{1,20}$/.test(uid) ? uid : undefined;
  const csrfToken = csrfTokenFrom(jar);
  return {
    kind: "connected",
    cookies: jar.toJSON(),
    ...(csrfToken ? { csrfToken } : {}),
    ...(userId ? { userId } : {}),
  };
}

function needsOtp(jar: CookieJar, username: string, message: string): LoginFlowResult {
  const csrfToken = csrfTokenFrom(jar);
  return {
    kind: "needs_otp",
    message,
    pending: {
      step: "otp",
      username,
      cookies: jar.toJSON(),
      ...(csrfToken ? { csrfToken } : {}),
    },
  };
}
