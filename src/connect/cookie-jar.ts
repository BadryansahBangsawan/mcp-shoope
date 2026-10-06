import { isBuyerShopeeDomain } from "../dispatcher/allowlist";
import type { StoredCookie } from "../session/types";

/**
 * Server-side cookie jar for Shopee buyer Connect (RFC 6265 subset).
 *
 * Only shopee.co.id / *.shopee.co.id cookies are accepted (Seller Centre and
 * partner hosts dropped). Max-Age<=0 or a past Expires deletes. Paths default
 * to "/". Secure is implied (https only).
 */

export const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const MAX_COOKIES = 64;
export const MAX_VALUE_LEN = 8192;
/** Session cookies Shopee sets after a real login. Paste and login-flow both require one. */
export const SESSION_COOKIE_NAMES = ["SPC_EC", "SPC_ST"] as const;

export function parseSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") {
    return withGetter.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function stripLeadingDot(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

/**
 * Chrome-style `Domain=.shopee.co.id` must match apex `shopee.co.id`.
 * A leading dot also means the cookie is not host-only.
 */
function domainMatches(host: string, cookie: StoredCookie): boolean {
  const domain = stripLeadingDot(cookie.domain);
  const hostOnly = cookie.domain.startsWith(".") ? false : cookie.hostOnly;
  if (hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeStoredCookie(c: StoredCookie): StoredCookie {
  const hadDot = c.domain.startsWith(".");
  return {
    ...c,
    domain: stripLeadingDot(c.domain),
    hostOnly: hadDot ? false : c.hostOnly,
  };
}

/** True when this cookie would be sent to `host` (RFC 6265 domain-match subset). */
export function cookieMatchesHost(cookie: StoredCookie, host: string): boolean {
  return domainMatches(host.toLowerCase(), cookie);
}

/** True when the jar holds SPC_EC or SPC_ST that would be sent to the buyer apex. */
export function hasBuyerSessionCookie(cookies: StoredCookie[], host = "shopee.co.id"): boolean {
  const names: readonly string[] = SESSION_COOKIE_NAMES;
  return cookies.some((c) => names.includes(c.name) && Boolean(c.value) && cookieMatchesHost(c, host));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

export function isStoredCookie(v: unknown): v is StoredCookie {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<StoredCookie>;
  return (
    typeof c.name === "string" &&
    COOKIE_NAME_RE.test(c.name) &&
    typeof c.value === "string" &&
    c.value.length <= MAX_VALUE_LEN &&
    typeof c.domain === "string" &&
    isBuyerShopeeDomain(c.domain) &&
    typeof c.hostOnly === "boolean" &&
    typeof c.path === "string" &&
    c.path.startsWith("/") &&
    (c.expiresAt === undefined || typeof c.expiresAt === "number")
  );
}

export class CookieJar {
  #cookies: StoredCookie[];

  constructor(cookies: StoredCookie[] = []) {
    this.#cookies = cookies.filter(isStoredCookie).map(normalizeStoredCookie);
  }

  /** Rebuild from persisted pending/session state; drops anything malformed. */
  static fromJSON(raw: unknown): CookieJar {
    return new CookieJar(Array.isArray(raw) ? raw.filter(isStoredCookie) : []);
  }

  toJSON(now = Date.now()): StoredCookie[] {
    return this.#live(now).map((c) => ({ ...c }));
  }

  /** Set a host-only cookie as if `url`'s host had sent it. */
  set(url: URL, name: string, value: string): void {
    this.#store({
      name,
      value,
      domain: url.hostname.toLowerCase(),
      hostOnly: true,
      path: "/",
    });
  }

  /** Apply every Set-Cookie header of a response received from `url`. */
  applyResponse(url: URL, headers: Headers, now = Date.now()): void {
    for (const line of parseSetCookieHeaders(headers)) this.applySetCookie(url, line, now);
  }

  applySetCookie(url: URL, line: string, now = Date.now()): void {
    const [pair = "", ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!COOKIE_NAME_RE.test(name) || value.length > MAX_VALUE_LEN) return;

    const host = url.hostname.toLowerCase();
    let domain = host;
    let hostOnly = true;
    let path = "/";
    let expiresAt: number | undefined;
    let maxAgeSeen = false;
    for (const attr of attrs) {
      const i = attr.indexOf("=");
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? "" : attr.slice(i + 1).trim();
      if (key === "domain" && val) {
        const d = val.replace(/^\./, "").toLowerCase();
        if (!(host === d || host.endsWith(`.${d}`)) || !isBuyerShopeeDomain(d)) return;
        domain = d;
        hostOnly = false;
      } else if (key === "path" && val.startsWith("/")) {
        path = val;
      } else if (key === "max-age" && /^-?\d+$/.test(val)) {
        maxAgeSeen = true;
        expiresAt = now + Number(val) * 1000;
      } else if (key === "expires" && !maxAgeSeen) {
        const t = Date.parse(val);
        if (Number.isFinite(t)) expiresAt = t;
      }
    }
    if (!isBuyerShopeeDomain(domain)) return;
    const cookie: StoredCookie = { name, value, domain, hostOnly, path };
    if (expiresAt !== undefined) cookie.expiresAt = expiresAt;
    if (expiresAt !== undefined && expiresAt <= now) {
      this.#remove(cookie);
      return;
    }
    this.#store(cookie);
  }

  /** Cookie header value the browser would send to `url`. */
  headerFor(url: URL, now = Date.now()): string {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    return this.#live(now)
      .filter((c) => domainMatches(host, c) && pathMatches(path, c.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Value of `name` as it would be sent to `url`, or null. */
  get(url: URL, name: string, now = Date.now()): string | null {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const hit = this.#live(now)
      .filter((c) => c.name === name && domainMatches(host, c) && pathMatches(path, c.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return hit ? hit.value : null;
  }

  #live(now: number): StoredCookie[] {
    return this.#cookies.filter((c) => c.expiresAt === undefined || c.expiresAt > now);
  }

  #same(a: StoredCookie, b: StoredCookie): boolean {
    return a.name === b.name && a.domain === b.domain && a.path === b.path && a.hostOnly === b.hostOnly;
  }

  #remove(cookie: StoredCookie): void {
    this.#cookies = this.#cookies.filter((c) => !this.#same(c, cookie));
  }

  #store(cookie: StoredCookie): void {
    this.#remove(cookie);
    this.#cookies.push(cookie);
    if (this.#cookies.length > MAX_COOKIES) this.#cookies.splice(0, this.#cookies.length - MAX_COOKIES);
  }
}
