import { AppError, ErrorCodes } from "../errors/codes";

/**
 * Single-owner authentication for browser pages (/authorize consent, /login, /connect).
 *
 * - OWNER_PASSWORD (Worker secret, >= 12 chars) proves the human is the owner.
 * - Owner cookie is an HMAC-signed, expiring token. The HMAC key is derived via
 *   HKDF from SESSION_ENCRYPTION_KEY with the password digest as salt, so
 *   rotating either secret invalidates every issued cookie.
 * - Fails closed when either secret is missing.
 */

export const OWNER_SUBJECT = "owner";
const OWNER_COOKIE_TTL_S = 8 * 60 * 60;
const CSRF_COOKIE_TTL_S = OWNER_COOKIE_TTL_S;
const MIN_PASSWORD_LENGTH = 12;

export interface OwnerEnv {
  OWNER_PASSWORD?: string;
  SESSION_ENCRYPTION_KEY?: string;
}

export interface OwnerIdentity {
  subject: typeof OWNER_SUBJECT;
  expiresAt: number;
}

const enc = new TextEncoder();

export function ownerAuthConfigured(env: OwnerEnv): boolean {
  return (
    (env.OWNER_PASSWORD?.trim().length ?? 0) >= MIN_PASSWORD_LENGTH &&
    Boolean(env.SESSION_ENCRYPTION_KEY?.trim())
  );
}

function assertConfigured(env: OwnerEnv): { password: string; secret: string } {
  if (!ownerAuthConfigured(env)) {
    throw new AppError(
      ErrorCodes.UNAUTHORIZED,
      `Owner auth not configured (OWNER_PASSWORD >= ${MIN_PASSWORD_LENGTH} chars and SESSION_ENCRYPTION_KEY are required)`,
    );
  }
  return { password: env.OWNER_PASSWORD!.trim(), secret: env.SESSION_ENCRYPTION_KEY!.trim() };
}

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

/** Constant-time comparison of two strings (compares SHA-256 digests). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

export async function verifyOwnerPassword(env: OwnerEnv, candidate: string): Promise<boolean> {
  const { password } = assertConfigured(env);
  if (!candidate) return false;
  return constantTimeEqual(candidate, password);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function signingKey(env: OwnerEnv): Promise<CryptoKey> {
  const { password, secret } = assertConfigured(env);
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: await sha256(`owner:${password}`), info: enc.encode("sp-owner-cookie-v1") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

async function hmac(env: OwnerEnv, msg: string): Promise<string> {
  const key = await signingKey(env);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg))));
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

/** `__Host-` prefix on https (Secure, Path=/, no Domain); plain name on local http. */
function cookieName(request: Request, base: string): string {
  return isHttps(request) ? `__Host-${base}` : base;
}

function serializeCookie(request: Request, base: string, value: string, maxAge: number): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${cookieName(request, base)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function issueOwnerCookie(request: Request, env: OwnerEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    enc.encode(JSON.stringify({ v: 1, sub: OWNER_SUBJECT, iat: now, exp: now + OWNER_COOKIE_TTL_S })),
  );
  const sig = await hmac(env, `owner.${payload}`);
  return serializeCookie(request, "sp_owner", `${payload}.${sig}`, OWNER_COOKIE_TTL_S);
}

export function clearOwnerCookie(request: Request): string {
  return serializeCookie(request, "sp_owner", "", 0);
}

/** Returns the owner identity when a valid, unexpired owner cookie is present. */
export async function readOwner(request: Request, env: OwnerEnv): Promise<OwnerIdentity | null> {
  if (!ownerAuthConfigured(env)) return null;
  const raw = readCookie(request, cookieName(request, "sp_owner"));
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!(await constantTimeEqual(sig, await hmac(env, `owner.${payload}`)))) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(payload)) as { v?: number; sub?: string; exp?: number };
    if (parsed.v !== 1 || parsed.sub !== OWNER_SUBJECT || typeof parsed.exp !== "number") return null;
    if (parsed.exp * 1000 <= Date.now()) return null;
    return { subject: OWNER_SUBJECT, expiresAt: parsed.exp * 1000 };
  } catch {
    return null;
  }
}

/** Double-submit CSRF token: reuse the cookie value or mint a new one. */
export function ensureCsrf(request: Request): { token: string; setCookie?: string } {
  const existing = readCookie(request, cookieName(request, "sp_csrf"));
  // Re-issue on reuse so a page that embeds the token never outlives its cookie.
  if (existing && /^[a-f0-9]{32}$/.test(existing)) {
    return { token: existing, setCookie: serializeCookie(request, "sp_csrf", existing, CSRF_COOKIE_TTL_S) };
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  return { token, setCookie: serializeCookie(request, "sp_csrf", token, CSRF_COOKIE_TTL_S) };
}

export async function assertCsrf(request: Request, formToken: string | null | undefined): Promise<void> {
  const cookie = readCookie(request, cookieName(request, "sp_csrf"));
  const provided = formToken?.trim() ?? "";
  if (!cookie || !provided || !(await constantTimeEqual(cookie, provided))) {
    throw new AppError(ErrorCodes.FORBIDDEN, "Invalid or missing CSRF token");
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}
