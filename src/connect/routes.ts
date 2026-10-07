import { clientIp } from "../auth/owner";
import { AppError, ErrorCodes } from "../errors/codes";
import { log } from "../observability/log";
import {
  CompositeShopeeSessionProvider,
  sessionsDoForOwner,
  type ShopeeSessionsStub,
} from "../session/shopee-session";
import { maskTokenPrefix, type PendingAuthState } from "../session/types";
import { htmlResponse } from "../web/html";
import {
  assertFormCsrf,
  requireConnectAccess,
  withSetCookies,
  type ConnectGateEnv,
  type ConnectIdentity,
} from "./gate";
import {
  connectDisconnectedHtml,
  connectGoneHtml,
  connectLoginPage,
  connectOtpPage,
  connectSuccessHtml,
} from "./html";
import { continueWithOtp, resendOtp, runShopeeLoginFlow } from "./login-flow";
import { isValidOtp, normalizeUsername } from "./login-parse";
import { validatePasteBundle } from "./paste";
import {
  appErrorLike,
  connectStepErrorHtml,
  jsonResponse,
  mapConnectError,
  readFormFields,
  readPasteRequest,
  respondLoginResult,
  wantsJson,
} from "./result-handlers";

export interface ConnectEnv extends ConnectGateEnv {
  SHOPEE_SESSIONS: DurableObjectNamespace;
  PUBLIC_BASE_URL: string;
  SHOPEE_REGION?: string;
}

const LOGIN_WINDOW_MS = 15 * 60_000;

const HOP_GONE = "SSO Google/Facebook/Apple dan otorisasi Open Platform tidak didukung.";

const HOP_PATHS = new Set(["/connect/authorize", "/connect/callback", "/connect/sso", "/connect/picker"]);

async function loginAttemptAllowed(
  doStub: ShopeeSessionsStub,
  request: Request,
  username: string,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const user = normalizeUsername(username) || "(empty)";
  const results = await Promise.all([
    doStub.checkRateLimit({ key: `connect-pin:ip:${clientIp(request)}`, limit: 10, windowMs: LOGIN_WINDOW_MS }),
    doStub.checkRateLimit({ key: `connect-pin:user:${user}`, limit: 6, windowMs: LOGIN_WINDOW_MS }),
    doStub.checkRateLimit({ key: "connect-pin:global", limit: 20, windowMs: LOGIN_WINDOW_MS }),
  ]);
  const blocked = results.filter((r) => !r.ok);
  if (!blocked.length) return { ok: true };
  return { ok: false, retryAfterMs: Math.max(...blocked.map((r) => r.retryAfterMs)) };
}

function rateLimited(
  request: Request,
  identity: ConnectIdentity,
  retryAfterMs: number,
  pending?: PendingAuthState | null,
): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const msg = `Terlalu banyak percobaan masuk; coba lagi dalam ${seconds}s`;
  const res = wantsJson(request)
    ? jsonResponse({ code: ErrorCodes.SHOPEE_RATE_LIMITED, message: msg }, 429)
    : htmlResponse(connectStepErrorHtml(identity.csrfToken, msg, pending), 429);
  res.headers.set("retry-after", String(seconds));
  return res;
}

function gone(request: Request, identity: ConnectIdentity, msg: string): Response {
  return wantsJson(request)
    ? jsonResponse({ code: ErrorCodes.INVALID_INPUT, message: msg }, 410)
    : htmlResponse(connectGoneHtml({ csrfToken: identity.csrfToken, message: msg }), 410);
}

/** Runs a login step; any thrown failure also drops pending state so nothing lingers. */
async function withPendingCleanup(doStub: ShopeeSessionsStub, step: () => Promise<Response>): Promise<Response> {
  try {
    return await step();
  } catch (err) {
    await doStub.clearPending().catch(() => undefined);
    throw err;
  }
}

export async function handleConnectRoutes(
  request: Request,
  env: ConnectEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/connect" && !url.pathname.startsWith("/connect/")) return null;

  let identity: ConnectIdentity;
  try {
    identity = await requireConnectAccess(request, env);
  } catch (err) {
    const app = appErrorLike(err);
    if (!app) throw err;
    if (request.method === "GET" && !wantsJson(request)) {
      const next = encodeURIComponent(`${url.pathname}${url.search}`);
      return new Response(null, {
        status: 302,
        headers: { location: `/login?next=${next}`, "cache-control": "no-store" },
      });
    }
    return jsonResponse({ code: app.code, message: app.message }, app.status);
  }

  const doStub = sessionsDoForOwner(env.SHOPEE_SESSIONS);
  const respond = (res: Response) => withSetCookies(res, identity.setCookies);
  const loginOpts = {
    request,
    doStub,
    subject: identity.subject,
    csrfToken: identity.csrfToken,
  };

  try {
    if (HOP_PATHS.has(url.pathname)) {
      return respond(gone(request, identity, HOP_GONE));
    }

    if (request.method === "GET" && url.pathname === "/connect") {
      const pending = await doStub.getPending();
      if (pending) {
        return respond(htmlResponse(connectOtpPage({ csrfToken: identity.csrfToken, pending })));
      }
      const session = await doStub.getSession();
      if (session) {
        return respond(
          htmlResponse(
            connectSuccessHtml({
              csrfToken: identity.csrfToken,
              via: session.source,
              cookieCount: session.cookies.length,
              userPrefix: session.userId ? maskTokenPrefix(session.userId) : undefined,
            }),
          ),
        );
      }
      return respond(htmlResponse(connectLoginPage({ csrfToken: identity.csrfToken })));
    }

    if (request.method === "GET" && url.pathname === "/connect/status") {
      return respond(jsonResponse(await connectStatus(doStub, identity)));
    }

    if (request.method === "POST" && url.pathname === "/connect/login") {
      const body = await readFormFields(request);
      await assertFormCsrf(identity, body.csrf);
      const rate = await loginAttemptAllowed(doStub, request, body.username ?? "");
      if (!rate.ok) return respond(rateLimited(request, identity, rate.retryAfterMs));
      log("info", "connect.login.start", {
        subject: identity.subject,
        usernameLen: (body.username ?? "").length,
      });
      return respond(
        await withPendingCleanup(doStub, async () => {
          const result = await runShopeeLoginFlow({
            username: body.username ?? "",
            password: body.password ?? "",
          });
          return respondLoginResult({ ...loginOpts, result });
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/connect/otp") {
      const body = await readFormFields(request);
      await assertFormCsrf(identity, body.csrf);
      const vcode = (body.vcode ?? body.otp ?? "").trim();
      if (!isValidOtp(vcode)) {
        throw new AppError(ErrorCodes.INVALID_INPUT, "OTP harus 4–8 karakter alfanumerik");
      }
      const pendingPeek = await doStub.getPending();
      if (!pendingPeek) {
        throw new AppError(ErrorCodes.INVALID_INPUT, "Tidak ada OTP yang menunggu. Masuk ulang.");
      }
      const rate = await loginAttemptAllowed(doStub, request, pendingPeek.username);
      if (!rate.ok) return respond(rateLimited(request, identity, rate.retryAfterMs, pendingPeek));
      const pending = await doStub.takePending();
      if (!pending) {
        throw new AppError(ErrorCodes.INVALID_INPUT, "Tidak ada OTP yang menunggu. Masuk ulang.");
      }
      return respond(
        await withPendingCleanup(doStub, async () => {
          const result = await continueWithOtp({ pending, vcode });
          return respondLoginResult({ ...loginOpts, result });
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/connect/otp/resend") {
      const body = await readFormFields(request);
      await assertFormCsrf(identity, body.csrf);
      const pending = await doStub.getPending();
      if (!pending) {
        throw new AppError(ErrorCodes.INVALID_INPUT, "Tidak ada OTP yang menunggu. Masuk ulang.");
      }
      const rate = await loginAttemptAllowed(doStub, request, pending.username);
      if (!rate.ok) return respond(rateLimited(request, identity, rate.retryAfterMs, pending));
      return respond(
        await withPendingCleanup(doStub, async () => {
          const result = await resendOtp({ pending });
          return respondLoginResult({ ...loginOpts, result });
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/connect/cancel") {
      const body = await readFormFields(request);
      await assertFormCsrf(identity, body.csrf);
      await doStub.clearPending();
      if (wantsJson(request)) return respond(jsonResponse({ pending: false }));
      return respond(htmlResponse(connectLoginPage({ csrfToken: identity.csrfToken })));
    }

    if (request.method === "POST" && url.pathname === "/connect/paste") {
      const body = await readPasteRequest(request);
      await assertFormCsrf(identity, body.csrf);
      const paste = validatePasteBundle(body.bundle);
      const saved = await doStub.saveSession({
        cookies: paste.cookies,
        csrfToken: paste.csrfToken,
        subject: identity.subject,
        source: "paste",
        userId: paste.userId,
      });
      const userPrefix = saved.userId ? maskTokenPrefix(saved.userId) : undefined;
      log("info", "connect.paste.success", {
        subject: identity.subject,
        cookieCount: saved.cookies.length,
        ...(userPrefix ? { userPrefix } : {}),
      });
      if (wantsJson(request)) {
        return respond(
          jsonResponse({
            connected: true,
            source: "paste",
            cookieCount: saved.cookies.length,
            ...(userPrefix ? { userPrefix } : {}),
          }),
        );
      }
      return respond(
        htmlResponse(
          connectSuccessHtml({
            csrfToken: identity.csrfToken,
            via: "paste",
            cookieCount: saved.cookies.length,
            userPrefix,
          }),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/connect/disconnect") {
      const body = await readFormFields(request);
      await assertFormCsrf(identity, body.csrf);
      await doStub.clear();
      log("info", "connect.disconnect", { subject: identity.subject });
      if (wantsJson(request)) {
        return respond(jsonResponse({ connected: false }));
      }
      return respond(htmlResponse(connectDisconnectedHtml(identity.csrfToken)));
    }

    return respond(new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } }));
  } catch (err) {
    const pending = await doStub.getPending().catch(() => null);
    return respond(mapConnectError(request, identity.csrfToken, err, pending));
  }
}

async function connectStatus(
  doStub: ShopeeSessionsStub,
  identity: ConnectIdentity,
): Promise<Record<string, unknown>> {
  const doStatus = await doStub.status();
  if (doStatus.connected) {
    return {
      connected: true,
      region: doStatus.region,
      connectedAt: doStatus.connectedAt,
      source: doStatus.source ?? "login",
      cookieCount: doStatus.cookieCount,
      userPrefix: doStatus.userPrefix,
      subject: identity.subject,
    };
  }
  return {
    connected: false,
    region: doStatus.region,
    subject: identity.subject,
  };
}

/** Cookie session provider for MCP. Fails closed without a stored buyer session. */
export function createSessionProvider(env: ConnectEnv): CompositeShopeeSessionProvider {
  return new CompositeShopeeSessionProvider({
    sessionsDo: sessionsDoForOwner(env.SHOPEE_SESSIONS),
  });
}

/** Exported for tests that assert the 410 copy. */
export function ssoGoneMessage(): string {
  return HOP_GONE;
}
