import { hostKeyForName } from "../dispatcher/allowlist";
import type { HostKey } from "./types";

/** Upstream API docs bundled as shopee://docs/<name> resources. */
export const API_DOC_NAMES = [
  "auth-login",
  "account",
  "orders",
  "cart",
  "address",
  "voucher",
  "notifications",
  "chat",
  "wallet",
  "exclusions",
] as const;

/**
 * Extracts every upstream METHOD + host + path documented in the API markdown.
 * Pure (no fs): callers pass `{ "account.md": markdown, ... }`.
 *
 * Recognised shape:
 *   `GET https://shopee.co.id/buyer/login`
 *   `POST https://shopee.co.id/api/v2/authentication/login`
 *
 * Worker Connect URLs on mcp.shopee.badry.engineer are not extracted
 * (host regex excludes that domain). architecture docs are not in API_DOC_NAMES.
 */
export interface DocEndpoint {
  sourceDocument: string;
  method: string;
  host: HostKey;
  path: string;
  evidence: string;
}

const METHOD = "GET|POST|PUT|PATCH|DELETE";
const URL_BODY = "[^\\s`'\"|)<>]*";
const HOSTED = `https://shopee\\.co\\.id/${URL_BODY}`;

export function parseDocUrl(raw: string): { host: HostKey; path: string } | null {
  let s = raw.trim().replace(/[.,;:]+$/, "");
  s = s.replace(/^https?:\/\//, "");
  const slash = s.indexOf("/");
  const hostname = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? "/" : s.slice(slash);
  const host = hostKeyForName(hostname);
  if (!host) return null;
  let path = rest.split(/[?#]/, 1)[0] ?? "/";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.includes("…") || path.includes("..") || path.includes("//")) {
    return null;
  }
  return { host, path };
}

export function extractDocEndpoints(docs: Record<string, string>): DocEndpoint[] {
  const explicit: DocEndpoint[] = [];
  const seen = new Set<string>();
  const add = (doc: string, method: string, raw: string, line: string) => {
    const p = parseDocUrl(raw);
    if (!p) return;
    const key = `${doc}\0${method}\0${p.host}\0${p.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    explicit.push({
      sourceDocument: doc,
      method,
      host: p.host,
      path: p.path,
      evidence: line.trim(),
    });
  };

  const re = new RegExp(`\\b(${METHOD}) +(${HOSTED})`, "g");
  for (const [doc, md] of Object.entries(docs)) {
    for (const line of md.split("\n")) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        add(doc, m[1] ?? "", m[2] ?? "", line);
      }
    }
  }
  return explicit;
}
