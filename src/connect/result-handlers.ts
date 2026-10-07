import { discardBody, readStreamCapped } from "../dispatcher/upstream";
import { AppError, ErrorCodes, type ErrorCode } from "../errors/codes";
import { log } from "../observability/log";
import type { ShopeeSessionsStub } from "../session/shopee-session";
import { maskTokenPrefix, type PendingAuthState } from "../session/types";
import { htmlResponse } from "../web/html";
import {
  connectErrorHtml,
  connectOtpPage,
  connectPasteNeededHtml,
  connectSuccessHtml,
} from "./html";
import type { LoginFlowResult } from "./login-flow";

/** Cookie paste is a JSON object (up to 64 cookies). */
export const MAX_BODY_BYTES = 256_000;

export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const ct = request.headers.get("content-type") ?? "";
  return (
    accept.includes("application/json") ||
    ct.includes("application/json") ||
    new URL(request.url).searchParams.get("format") === "json"
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export interface AppErrorLike {
  code: ErrorCode;
  status: number;
  message: string;
}

export function appErrorLike(err: unknown): AppErrorLike | null {
  if (err instanceof AppError) return { code: err.code, status: err.status, message: err.message };
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  if (e.name !== "AppError" || typeof e.code !== "string") return null;
  const code = e.code as ErrorCode;
  let status = 500;
  if (typeof e.status === "number" && e.status >= 400 && e.status <= 599) status = e.status;
  else if (Object.hasOwn(ErrorCodes, code)) status = new AppError(code, "").status;
  return { code, status, message: typeof e.message === "string" ? e.message : "Error" };
}

function bodyTooLarge(): AppError {
  return new AppError(ErrorCodes.INVALID_INPUT, "Request body too large");
}

async function readCappedRequestBytes(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_BODY_BYTES) {
    discardBody(request);
    throw bodyTooLarge();
  }
  return readStreamCapped(request.body, {
    maxBytes: MAX_BODY_BYTES,
    tooLarge: bodyTooLarge,
    onReadFailed: () => new AppError(ErrorCodes.INVALID_INPUT, "Unreadable request body"),
  });
}

function requestFromBytes(request: Request, bytes: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}

function parseJsonObject(bytes: Uint8Array, unreadable: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(ErrorCodes.INVALID_INPUT, unreadable);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "JSON body must be an object");
  }
  return json as Record<string, unknown>;
}

/** Flat string fields for CSRF / login / OTP / disconnect forms. */
export async function readFormFields(request: Request): Promise<Record<string, string>> {
  const bytes = await readCappedRequestBytes(request);
  const ct = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  try {
    if (ct.includes("application/json")) {
      for (const [k, v] of Object.entries(parseJsonObject(bytes, "Unreadable request body"))) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out[k] = String(v);
        }
      }
      return out;
    }
    const fd = await requestFromBytes(request, bytes).formData();
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err) {
    if (appErrorLike(err)) throw err;
    throw new AppError(ErrorCodes.INVALID_INPUT, "Unreadable request body");
  }
}

export interface PasteRequestBody {
  csrf?: string;
  bundle: unknown;
}

/**
 * Cookie JSON reader. Accepts a bundle object (optionally plus `csrf`) or a form
 * field `tokens` / `bundle` containing that JSON.
 */
export async function readPasteRequest(request: Request): Promise<PasteRequestBody> {
  const bytes = await readCappedRequestBytes(request);
  const ct = request.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const o = parseJsonObject(bytes, "Unreadable paste body");
      if (o.tokens !== undefined || o.bundle !== undefined) {
        const raw = o.tokens ?? o.bundle;
        const bundle = typeof raw === "string" ? parseBundleString(raw) : raw;
        return { csrf: typeof o.csrf === "string" ? o.csrf : undefined, bundle };
      }
      return { csrf: typeof o.csrf === "string" ? o.csrf : undefined, bundle: o };
    }
    const fd = await requestFromBytes(request, bytes).formData();
    const csrf = fd.get("csrf");
    const raw = fd.get("tokens") ?? fd.get("bundle");
    if (typeof raw !== "string" || !raw.trim()) {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Form field `tokens` (JSON) is required");
    }
    return {
      csrf: typeof csrf === "string" ? csrf : undefined,
      bundle: parseBundleString(raw),
    };
  } catch (err) {
    if (appErrorLike(err)) throw err;
    throw new AppError(ErrorCodes.INVALID_INPUT, "Unreadable paste body");
  }
}

function parseBundleString(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(ErrorCodes.INVALID_INPUT, "tokens is not valid JSON");
  }
}

export async function respondLoginResult(opts: {
  request: Request;
  result: LoginFlowResult;
  doStub: ShopeeSessionsStub;
  subject: string;
  csrfToken: string;
}): Promise<Response> {
  const { request, result, doStub, subject, csrfToken } = opts;
  const json = wantsJson(request);

  if (result.kind === "needs_otp") {
    const pending = await doStub.savePending(result.pending);
    if (json) {
      return jsonResponse({ needs_otp: true, username: pending.username });
    }
    return htmlResponse(
      connectOtpPage({
        csrfToken,
        pending,
        statusHtml: result.message ? `<p class="ok" role="status">${escText(result.message)}</p>` : undefined,
      }),
    );
  }

  if (result.kind === "error") {
    await doStub.clearPending();
    const status = result.status && result.status >= 400 && result.status < 600 ? result.status : 401;
    if (json) {
      return jsonResponse({ code: ErrorCodes.UNAUTHORIZED, message: result.message }, status === 429 ? 429 : 401);
    }
    return htmlResponse(connectErrorHtml({ csrfToken, message: result.message }), status === 429 ? 429 : 401);
  }

  if (result.kind === "needs_paste") {
    await doStub.clearPending();
    if (json) {
      return jsonResponse({ needs_paste: true, reason: result.reason });
    }
    return htmlResponse(connectPasteNeededHtml({ csrfToken, reason: result.reason }));
  }

  const saved = await doStub.saveSession({
    cookies: result.cookies,
    csrfToken: result.csrfToken,
    subject,
    source: "login",
    userId: result.userId,
  });
  const userPrefix = result.userId ? maskTokenPrefix(result.userId) : undefined;
  log("info", "connect.login.success", {
    subject,
    cookieCount: saved.cookies.length,
    ...(userPrefix ? { userPrefix } : {}),
  });
  if (json) {
    return jsonResponse({
      connected: true,
      source: "login",
      cookieCount: saved.cookies.length,
      ...(userPrefix ? { userPrefix } : {}),
    });
  }
  return htmlResponse(
    connectSuccessHtml({
      csrfToken,
      via: "login",
      cookieCount: saved.cookies.length,
      userPrefix,
    }),
  );
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mapConnectError(
  request: Request,
  csrfToken: string,
  err: unknown,
  pending?: PendingAuthState | null,
): Response {
  const app = appErrorLike(err);
  if (app) {
    if (wantsJson(request)) {
      return jsonResponse({ code: app.code, message: app.message }, app.status);
    }
    return htmlResponse(connectStepErrorHtml(csrfToken, app.message, pending), app.status);
  }
  log("error", "connect.unhandled", {
    err: err instanceof Error ? err.name : typeof err,
  });
  if (wantsJson(request)) {
    return jsonResponse({ code: ErrorCodes.UPSTREAM_ERROR, message: "Internal error" }, 500);
  }
  return htmlResponse(
    connectStepErrorHtml(csrfToken, "Kesalahan internal. Coba lagi.", pending),
    500,
  );
}

/** OTP-step failures stay on the OTP form while pending exists; otherwise the password form. */
export function connectStepErrorHtml(
  csrfToken: string,
  message: string,
  pending?: PendingAuthState | null,
): string {
  const statusHtml = `<p class="err" role="alert">${escText(message)}</p>`;
  if (pending) return connectOtpPage({ csrfToken, pending, statusHtml });
  return connectErrorHtml({ csrfToken, message });
}
