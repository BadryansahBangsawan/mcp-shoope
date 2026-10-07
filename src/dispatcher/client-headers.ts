/**
 * Browser identity for shopee.co.id fetches. Not anti-bot tokens.
 *
 * Worker fetch defaults to a non-browser User-Agent (or none). Shopee answers
 * that with 403 on login hops and some account XHR even when the cookie jar is
 * valid. These headers match a PC Chrome session; do not add `af-ac-enc-*`.
 */

export const SHOPEE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36";

export const SHOPEE_ACCEPT_LANGUAGE = "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7";

export const SHOPEE_LANGUAGE = "id";

export const SHOPEE_API_SOURCE = "pc";

export const SHOPEE_HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type ShopeeClientKind = "html" | "xhr";

/** Mutates `headers` in place. Origin/Referer/Cookie/CSRF stay with the caller. */
export function applyShopeeBrowserHeaders(headers: Headers, kind: ShopeeClientKind): void {
  headers.set("user-agent", SHOPEE_USER_AGENT);
  headers.set("accept-language", SHOPEE_ACCEPT_LANGUAGE);
  if (kind === "xhr") {
    headers.set("x-api-source", SHOPEE_API_SOURCE);
    headers.set("x-shopee-language", SHOPEE_LANGUAGE);
    headers.set("x-requested-with", "XMLHttpRequest");
  }
}
