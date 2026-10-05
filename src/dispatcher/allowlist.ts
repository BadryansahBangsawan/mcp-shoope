import { AppError, ErrorCodes } from "../errors/codes";
import type { HostKey } from "../registry/types";

export const HOSTS: Record<HostKey, string> = {
  www: "shopee.co.id",
};

const ALLOWED_HOSTS = new Set<string>([HOSTS.www]);

const HOST_BY_NAME: ReadonlyMap<string, HostKey> = new Map([[HOSTS.www, "www"]]);

/**
 * Buyer web host only. Drops Seller Centre and partner/Open Platform hosts
 * even when they sit under *.shopee.co.id.
 */
export function isBuyerShopeeDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\./, "");
  if (!d) return false;
  if (d === "seller.shopee.co.id" || d.endsWith(".seller.shopee.co.id")) return false;
  if (d.includes("partner")) return false;
  return d === "shopee.co.id" || d.endsWith(".shopee.co.id");
}

export function resolveHost(host: HostKey): string {
  const hostname = HOSTS[host];
  if (!hostname || !ALLOWED_HOSTS.has(hostname)) {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, `Unknown host key: ${host}`);
  }
  return hostname;
}

export function hostKeyForName(hostname: string): HostKey | undefined {
  return HOST_BY_NAME.get(hostname.toLowerCase().replace(/\.$/, ""));
}

/** Validate a fully resolved URL is on the buyer-web allowlist. */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, "Only https allowed");
  }
  if (url.username || url.password) {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, "Userinfo not allowed");
  }
  if (url.port && url.port !== "443") {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, "Non-default ports not allowed");
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, `Host not allowlisted: ${url.hostname}`);
  }
  if (url.pathname.includes("..") || url.pathname.includes("//")) {
    throw new AppError(ErrorCodes.HOST_NOT_ALLOWED, "Path traversal rejected");
  }
}

/** Buyer login pages: a 3xx here means the stored jar is no longer a session. */
export function isShopeeLoginUrl(url: URL): boolean {
  if (!isBuyerShopeeDomain(url.hostname)) return false;
  const p = url.pathname.toLowerCase();
  return (
    p === "/buyer/login" ||
    p.startsWith("/buyer/login/") ||
    p === "/buyer/signin" ||
    p.startsWith("/buyer/signin/")
  );
}
