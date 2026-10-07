/**
 * Browser identity for shopee.co.id fetches. Not anti-bot tokens.
 *
 * Worker fetch defaults to a non-browser User-Agent (or none). Shopee answers
 * that with 403 on login hops and some account XHR even when the cookie jar is
 * valid. These headers match a PC Chrome session; do not add `af-ac-enc-*`.
 */

import { HOSTS } from "./allowlist";

export const SHOPEE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36";

export const SHOPEE_ACCEPT_LANGUAGE = "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7";

export const SHOPEE_LANGUAGE = "id";

export const SHOPEE_API_SOURCE = "pc";

export const SHOPEE_HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Client Hints that match SHOPEE_USER_AGENT (Chrome 141 / Windows). Not tokens. */
export const SHOPEE_SEC_CH_UA =
  `"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"`;

export const SHOPEE_SEC_CH_UA_MOBILE = "?0";

export const SHOPEE_SEC_CH_UA_PLATFORM = `"Windows"`;

export type ShopeeClientKind = "html" | "xhr";

const ORIGIN = `https://${HOSTS.www}`;

/**
 * UI path that owns each captured XHR. Login hops already send the login page
 * as Referer; homepage `/` 403s some purchase/cart/voucher list calls.
 * Values are path-only (must start with `/`, no `..`).
 */
const REFERER_PATH: Record<string, string> = {
  "account.profile": "/user/account/profile",
  "orders.list": "/user/purchase",
  "orders.detail": "/user/purchase",
  "orders.count": "/user/purchase",
  "cart.get": "/cart",
  "address.list": "/user/account/address",
  "voucher.list": "/user/voucher-wallet",
  "voucher.meta": "/user/voucher-wallet",
  "notifications.list": "/user/notifications/order",
  "notifications.activities": "/user/notifications/activity",
  "wallet.overview": "/user/coin",
  "wallet.transactions": "/user/coin",
};

function assertSafeRefererPath(path: string): string {
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("\\")) {
    return "/";
  }
  return path;
}

/** Absolute Referer for a registered operation. Unknown ids fall back to origin `/`. */
export function refererForOperation(operationId: string): string {
  const path = assertSafeRefererPath(REFERER_PATH[operationId] ?? "/");
  return `${ORIGIN}${path}`;
}

/**
 * Ops whose list XHR 403s from a Worker IP unless the UI page is fetched first.
 * Warm-up is an HTML GET of `refererForOperation` in the same dispatch (Set-Cookie
 * applied in-memory only). Not profile/count — those already return 200.
 */
const PAGE_WARMUP_OPS = new Set(["orders.list", "orders.detail", "cart.get", "voucher.list"]);

export function needsPageWarmup(operationId: string): boolean {
  return PAGE_WARMUP_OPS.has(operationId);
}

/** Mutates `headers` in place. Origin/Referer/Cookie/CSRF stay with the caller. */
export function applyShopeeBrowserHeaders(headers: Headers, kind: ShopeeClientKind): void {
  headers.set("user-agent", SHOPEE_USER_AGENT);
  headers.set("accept-language", SHOPEE_ACCEPT_LANGUAGE);
  headers.set("sec-ch-ua", SHOPEE_SEC_CH_UA);
  headers.set("sec-ch-ua-mobile", SHOPEE_SEC_CH_UA_MOBILE);
  headers.set("sec-ch-ua-platform", SHOPEE_SEC_CH_UA_PLATFORM);
  if (kind === "xhr") {
    headers.set("x-api-source", SHOPEE_API_SOURCE);
    headers.set("x-shopee-language", SHOPEE_LANGUAGE);
    headers.set("x-requested-with", "XMLHttpRequest");
    headers.set("sec-fetch-dest", "empty");
    headers.set("sec-fetch-mode", "cors");
    headers.set("sec-fetch-site", "same-origin");
  } else {
    headers.set("sec-fetch-dest", "document");
    headers.set("sec-fetch-mode", "navigate");
    headers.set("sec-fetch-site", "same-origin");
    headers.set("sec-fetch-user", "?1");
    headers.set("upgrade-insecure-requests", "1");
  }
}
