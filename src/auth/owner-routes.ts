import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { AppError, ErrorCodes } from "../errors/codes";
import { log } from "../observability/log";
import { htmlResponse } from "../web/html";
import {
  assertCsrf,
  clearOwnerCookie,
  clientIp,
  ensureCsrf,
  issueOwnerCookie,
  OWNER_SUBJECT,
  ownerAuthConfigured,
  readOwner,
  verifyOwnerPassword,
  type OwnerEnv,
} from "./owner";
import { consentPage, ownerLoginPage, simpleErrorPage } from "./pages";
import { SCOPES } from "./scopes";

export interface OwnerRoutesEnv extends OwnerEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  SHOPEE_SESSIONS: DurableObjectNamespace;
  ENABLE_MUTATIONS: string;
}

/** Props stored on every OAuth grant; surfaced to /mcp as ctx.props. */
export interface GrantProps {
  subject: string;
  scopes: string[];
  clientId: string;
  clientName: string;
}

interface RateLimitStub {
  checkRateLimit(input: { key: string; limit?: number; windowMs?: number; peek?: boolean }): Promise<{
    ok: boolean;
    retryAfterMs: number;
  }>;
}

const MAX_PASSWORD_FAILURES = 10;

/**
 * Only failed attempts count, per client network (IPv4 address or IPv6 /64).
 * There is deliberately no global bucket: an attacker must not be able to lock
 * the owner out from another network. OWNER_PASSWORD has >= 12 chars, so
 * 10 guesses per network per 15 minutes cannot brute-force it.
 */
async function checkPassword(
  env: OwnerRoutesEnv,
  request: Request,
  password: string,
): Promise<string | null> {
  const stub = env.SHOPEE_SESSIONS.get(
    env.SHOPEE_SESSIONS.idFromName("ratelimit:owner-password"),
  ) as unknown as RateLimitStub;
  const key = `fail:${clientNetwork(request)}`;
  const status = await stub.checkRateLimit({ key, limit: MAX_PASSWORD_FAILURES, peek: true });
  if (!status.ok) {
    log("warn", "owner.password.rate_limited", {});
    return "Terlalu banyak percobaan gagal dari jaringan ini. Tunggu 15 menit lalu coba lagi.";
  }
  if (await verifyOwnerPassword(env, password)) return null;
  await stub.checkRateLimit({ key, limit: MAX_PASSWORD_FAILURES });
  log("warn", "owner.password.invalid", {});
  return "Password owner salah.";
}

function clientNetwork(request: Request): string {
  const ip = clientIp(request);
  return ip.includes(":") ? `${ip.split(":").slice(0, 4).join(":")}::/64` : ip;
}

function withCookies(res: Response, cookies: Array<string | undefined>): Response {
  const headers = new Headers(res.headers);
  for (const c of cookies) if (c) headers.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers });
}

function redirect(location: string, cookies: Array<string | undefined> = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) if (c) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

const NEXT_BASE = "https://next.invalid";

/** Post-login destinations: same-origin /connect or /approvals/:id paths only. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || /[\0-\x1f\x7f\\]/.test(raw)) return "/connect";
  let url: URL;
  try {
    url = new URL(raw, NEXT_BASE);
  } catch {
    return "/connect";
  }
  if (url.origin !== NEXT_BASE) return "/connect";
  if (url.pathname !== "/connect" && !url.pathname.startsWith("/connect/") && !/^\/approvals\/[0-9a-f-]{36}$/.test(url.pathname)) {
    return "/connect";
  }
  return `${url.pathname}${url.search}`;
}

function scopeChoices(requested: string[], mutationsEnabled: boolean) {
  const offered = new Set<string>([SCOPES.READ]);
  if (requested.includes(SCOPES.WRITE) || mutationsEnabled) offered.add(SCOPES.WRITE);
  if (requested.includes(SCOPES.ADMIN)) offered.add(SCOPES.ADMIN);
  return { offered: [...offered], defaults: [SCOPES.READ] as string[] };
}

export async function handleLogin(request: Request, env: OwnerRoutesEnv): Promise<Response> {
  if (!ownerAuthConfigured(env)) {
    return htmlResponse(simpleErrorPage("Belum dikonfigurasi", "Owner auth belum dikonfigurasi di server ini."), 503);
  }
  const url = new URL(request.url);
  const csrf = ensureCsrf(request);
  if (request.method === "GET") {
    const next = safeNext(url.searchParams.get("next"));
    if (await readOwner(request, env)) return redirect(next);
    return withCookies(htmlResponse(ownerLoginPage({ csrf: csrf.token, next })), [csrf.setCookie]);
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  const next = safeNext(String(form.get("next") ?? ""));
  try {
    await assertCsrf(request, String(form.get("csrf") ?? ""));
  } catch {
    return withCookies(
      htmlResponse(ownerLoginPage({ csrf: csrf.token, next, error: "Sesi kedaluwarsa — coba lagi." }), 403),
      [csrf.setCookie],
    );
  }
  const error = await checkPassword(env, request, String(form.get("password") ?? ""));
  if (error) {
    return htmlResponse(ownerLoginPage({ csrf: csrf.token, next, error }), 401);
  }
  log("info", "owner.login.success", {});
  return redirect(next, [await issueOwnerCookie(request, env)]);
}

export async function handleLogout(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData().catch(() => null);
  try {
    await assertCsrf(request, String(form?.get("csrf") ?? ""));
  } catch {
    return new Response("Invalid CSRF token", { status: 403, headers: { "cache-control": "no-store" } });
  }
  return redirect("/login", [clearOwnerCookie(request)]);
}

function oauthErrorRedirect(req: { redirectUri: string; state: string; issuer?: string }, code: string, description: string): Response {
  const target = new URL(req.redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (req.state) target.searchParams.set("state", req.state);
  if (req.issuer) target.searchParams.set("iss", req.issuer);
  return redirect(target.toString());
}

export async function handleAuthorize(request: Request, env: OwnerRoutesEnv): Promise<Response> {
  if (!ownerAuthConfigured(env)) {
    return htmlResponse(simpleErrorPage("Belum dikonfigurasi", "Owner auth belum dikonfigurasi di server ini."), 503);
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // The consent form posts back to the same URL, so the provider re-validates
  // the untampered query parameters on every step.
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      // Rendered locally even when the redirect URI validated: anyone can register a
      // client, so an automatic error redirect would make this an open redirector.
      return htmlResponse(simpleErrorPage("Otorisasi gagal", err.description), 400);
    }
    if (err instanceof CimdFetchError) {
      return htmlResponse(simpleErrorPage("Otorisasi gagal", "Dokumen metadata klien tidak dapat diambil."), 400);
    }
    throw err;
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) {
    return htmlResponse(simpleErrorPage("Otorisasi gagal", "Klien OAuth tidak dikenal."), 400);
  }

  const { offered, defaults } = scopeChoices(oauthReq.scope, env.ENABLE_MUTATIONS === "true");
  const csrf = ensureCsrf(request);
  const url = new URL(request.url);
  const render = async (status: number, error?: string, chosen?: string[]) =>
    withCookies(
      htmlResponse(
        consentPage({
          csrf: csrf.token,
          actionUrl: `${url.pathname}${url.search}`,
          clientName: client.clientName || "(unnamed client)",
          clientId: client.clientId,
          redirectUri: oauthReq.redirectUri,
          offeredScopes: offered,
          defaultScopes: chosen ?? defaults,
          needsPassword: !(await readOwner(request, env)),
          error,
        }),
        status,
      ),
      [csrf.setCookie],
    );

  if (request.method === "GET") return render(200);

  const form = await request.formData();
  try {
    await assertCsrf(request, String(form.get("csrf") ?? ""));
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.FORBIDDEN) {
      return render(403, "Sesi kedaluwarsa — tinjau dan setujui lagi.");
    }
    throw err;
  }
  if (form.get("decision") !== "approve") {
    log("info", "oauth.authorize.denied", { clientId: client.clientId });
    return oauthErrorRedirect(oauthReq, "access_denied", "The owner denied the request");
  }

  const chosen = form.getAll("scope").map(String);
  const granted = offered.filter((s) => chosen.includes(s));
  const cookies: string[] = [];
  if (!(await readOwner(request, env))) {
    const error = await checkPassword(env, request, String(form.get("password") ?? ""));
    if (error) return render(401, error, granted);
    cookies.push(await issueOwnerCookie(request, env));
  }
  if (!granted.length) return render(400, "Pilih setidaknya satu scope.", granted);

  const props: GrantProps = {
    subject: OWNER_SUBJECT,
    scopes: granted,
    clientId: client.clientId,
    clientName: client.clientName ?? "",
  };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: OWNER_SUBJECT,
    metadata: { clientName: client.clientName ?? "", grantedAt: Date.now() },
    scope: granted,
    props,
  });
  log("info", "oauth.authorize.approved", { clientId: client.clientId, scopes: granted });
  return redirect(redirectTo, cookies);
}
