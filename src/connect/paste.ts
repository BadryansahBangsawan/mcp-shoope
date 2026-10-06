import { HOSTS, isBuyerShopeeDomain } from "../dispatcher/allowlist";
import { AppError, ErrorCodes } from "../errors/codes";
import type { StoredCookie } from "../session/types";
import { COOKIE_NAME_RE, hasBuyerSessionCookie, MAX_COOKIES, MAX_VALUE_LEN } from "./cookie-jar";

export const PASTE_BUNDLE_VERSION = 1;
export const PASTE_SOURCE = "browser-export";

/** RFC 6265 cookie-octet plus space (export values may contain spaces). No `;`. */
const COOKIE_VALUE_RE = /^[\x20-\x3a\x3c-\x7e]*$/;

export interface PasteCookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
}

export interface PasteBundleInput {
  v: number;
  source: string;
  cookies: PasteCookieInput[];
}

export interface ValidatedPaste {
  cookies: StoredCookie[];
  csrfToken?: string;
  /** Buyer id from cookie SPC_U when it is all digits. Status only; not a secret. */
  userId?: string;
}

/**
 * Structured cookie paste. Extra keys ignored. Non-buyer domains are dropped
 * (not thrown) so a browser export that also holds Google/Facebook cookies still works.
 */
export function validatePasteBundle(raw: unknown): ValidatedPaste {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Paste bundle must be a JSON object");
  }
  const input = raw as Partial<PasteBundleInput>;
  if (input.v !== PASTE_BUNDLE_VERSION) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Paste bundle v must be 1");
  }
  if (input.source !== PASTE_SOURCE) {
    throw new AppError(ErrorCodes.INVALID_INPUT, `Paste bundle source must be ${PASTE_SOURCE}`);
  }
  if (!Array.isArray(input.cookies) || input.cookies.length < 1 || input.cookies.length > MAX_COOKIES) {
    throw new AppError(ErrorCodes.INVALID_INPUT, `Paste bundle needs 1–${MAX_COOKIES} cookies`);
  }

  const cookies: StoredCookie[] = [];
  for (const c of input.cookies) {
    const stored = toStoredCookie(c);
    if (stored) cookies.push(stored);
  }
  if (!cookies.length) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      "Paste bundle has no cookies on shopee.co.id (seller/partner and third-party cookies are dropped)",
    );
  }
  if (!hasBuyerSessionCookie(cookies, HOSTS.www)) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      "Paste bundle needs session cookie SPC_EC or SPC_ST for shopee.co.id",
    );
  }

  const csrf = cookies.find((c) => c.name === "csrftoken" && c.value);
  const uid = cookies.find((c) => c.name === "SPC_U")?.value;
  const userId = uid && /^\d{1,20}$/.test(uid) ? uid : undefined;
  return {
    cookies,
    ...(csrf ? { csrfToken: csrf.value } : {}),
    ...(userId ? { userId } : {}),
  };
}

function toStoredCookie(raw: unknown): StoredCookie | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Each cookie must be an object");
  }
  const c = raw as Partial<PasteCookieInput>;
  if (typeof c.name !== "string" || !COOKIE_NAME_RE.test(c.name)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Cookie name is not a valid RFC 6265 token");
  }
  if (typeof c.value !== "string" || !COOKIE_VALUE_RE.test(c.value) || c.value.length > MAX_VALUE_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      "Cookie value must be printable ASCII (max 8192) without ';'",
    );
  }
  if (typeof c.domain !== "string" || !c.domain.trim()) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Cookie domain is required");
  }
  const originalDomain = c.domain.trim();
  let domain = originalDomain.replace(/^\./, "").toLowerCase();
  if (!isBuyerShopeeDomain(domain)) return null;
  // Dispatcher only talks to the apex. Host-only www cookies would never be sent.
  let hostOnly = !originalDomain.startsWith(".");
  if (domain === "www.shopee.co.id") {
    domain = HOSTS.www;
    hostOnly = false;
  }
  const path = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
  const cookie: StoredCookie = {
    name: c.name,
    value: c.value,
    domain,
    hostOnly,
    path,
  };
  const expiresAt = expiresToMs(c.expires);
  if (expiresAt !== undefined) cookie.expiresAt = expiresAt;
  return cookie;
}

/** Playwright `expires` is unix seconds; already-ms values (≥ 1e12) are kept. */
function expiresToMs(expires: unknown): number | undefined {
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return undefined;
  return expires < 1e12 ? Math.trunc(expires * 1000) : Math.trunc(expires);
}
