import { AppError, ErrorCodes } from "../errors/codes";
import { constantTimeEqual, OWNER_SUBJECT } from "./owner";
import { SCOPES, hasScope, type Scope } from "./scopes";

export interface AuthPrincipal {
  subject: string;
  scopes: string[];
  clientId?: string;
  via: "oauth" | "dev-psk";
}

export interface DevPskEnv {
  ALLOW_DEV_PSK: string;
  DEV_PSK?: string;
}

const KNOWN_SCOPES = new Set<string>(Object.values(SCOPES));
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Build the MCP principal from props the OAuth provider attached to a verified
 * access token (ctx.props). Anything malformed fails closed.
 */
export function principalFromProps(props: unknown): AuthPrincipal {
  if (!props || typeof props !== "object") {
    throw new AppError(ErrorCodes.UNAUTHORIZED, "Missing token properties");
  }
  const p = props as Record<string, unknown>;
  if (typeof p.subject !== "string" || !p.subject || !Array.isArray(p.scopes)) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, "Malformed token properties");
  }
  const scopes = p.scopes.filter((s): s is string => typeof s === "string" && KNOWN_SCOPES.has(s));
  const via = p.via === "dev-psk" ? "dev-psk" : "oauth";
  return {
    subject: p.subject,
    scopes,
    clientId: typeof p.clientId === "string" ? p.clientId : undefined,
    via,
  };
}

/**
 * Local-development pre-shared key. Honoured only when ALLOW_DEV_PSK=true AND
 * the request targets a loopback host, so a misconfigured production deploy
 * still cannot be reached with the PSK.
 */
export async function resolveDevPsk(
  token: string,
  request: Request,
  env: DevPskEnv,
): Promise<Record<string, unknown> | null> {
  if (env.ALLOW_DEV_PSK !== "true") return null;
  const psk = env.DEV_PSK?.trim();
  if (!psk || psk.length < 16) return null;
  if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) return null;
  if (!(await constantTimeEqual(token, psk))) return null;
  return {
    subject: OWNER_SUBJECT,
    scopes: [SCOPES.READ, SCOPES.WRITE],
    clientId: "dev-psk",
    via: "dev-psk",
  };
}

export function requireScope(principal: AuthPrincipal, scope: Scope): void {
  if (!hasScope(principal.scopes, scope)) {
    throw new AppError(ErrorCodes.FORBIDDEN, `Missing scope ${scope}`);
  }
}
