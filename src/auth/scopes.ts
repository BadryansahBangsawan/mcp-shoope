export const SCOPES = {
  READ: "shopee:read",
  WRITE: "shopee:write",
  ADMIN: "shopee:admin",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

const KNOWN_SCOPES = new Set<string>(Object.values(SCOPES));

export function hasScope(granted: string[] | undefined, needed: Scope): boolean {
  if (!granted) return false;
  if (granted.includes(SCOPES.ADMIN)) return true;
  if (needed === SCOPES.READ) {
    return (
      granted.includes(SCOPES.READ) ||
      granted.includes(SCOPES.WRITE) ||
      granted.includes(SCOPES.ADMIN)
    );
  }
  return granted.includes(needed);
}

/** Normalize a grant or token-request scope list; unknown names dropped. */
export function parseScopeList(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : typeof raw === "string"
      ? raw.split(/[\s+]+/)
      : [];
  return parts.filter((s) => KNOWN_SCOPES.has(s));
}

/**
 * Access-token scopes: intersection of the consent grant and any downscope at
 * token exchange. Empty intersection keeps the grant (never mint a token with
 * no known scopes — that 401s every MCP tool).
 */
export function scopesForAccessToken(granted: unknown, requested: unknown): string[] {
  const g = parseScopeList(granted);
  const r = parseScopeList(requested);
  if (!r.length) return g;
  const inter = g.filter((s) => r.includes(s));
  return inter.length ? inter : g;
}
