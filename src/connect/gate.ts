import { constantTimeEqual, ensureCsrf, OWNER_SUBJECT, readOwner, type OwnerEnv } from "../auth/owner";
import { resolveDevPsk, type DevPskEnv } from "../auth/verify";
import { AppError, ErrorCodes } from "../errors/codes";

export interface ConnectGateEnv extends OwnerEnv, DevPskEnv {}

export interface ConnectIdentity {
  subject: string;
  via: "owner-cookie" | "dev-psk";
  csrfToken: string;
  /** Header-authenticated (non-cookie) callers cannot be CSRF'd. */
  csrfExempt: boolean;
  setCookies: string[];
}

/**
 * Gate /connect* routes:
 * 1. Signed owner cookie from /login (browser; forms need the double-submit CSRF token).
 * 2. Local dev only: `x-dev-psk` header on a loopback host (scripts/tests).
 */
export async function requireConnectAccess(
  request: Request,
  env: ConnectGateEnv,
): Promise<ConnectIdentity> {
  const owner = await readOwner(request, env);
  if (owner) {
    const csrf = ensureCsrf(request);
    return {
      subject: OWNER_SUBJECT,
      via: "owner-cookie",
      csrfToken: csrf.token,
      csrfExempt: false,
      setCookies: csrf.setCookie ? [csrf.setCookie] : [],
    };
  }

  const psk = request.headers.get("x-dev-psk")?.trim();
  if (psk && (await resolveDevPsk(psk, request, env))) {
    return {
      subject: OWNER_SUBJECT,
      via: "dev-psk",
      csrfToken: "",
      csrfExempt: true,
      setCookies: [],
    };
  }

  throw new AppError(ErrorCodes.UNAUTHORIZED, "Owner sign-in required");
}

export async function assertFormCsrf(
  identity: ConnectIdentity,
  formCsrf: string | null | undefined,
): Promise<void> {
  if (identity.csrfExempt) return;
  const provided = formCsrf?.trim() ?? "";
  if (!provided || !identity.csrfToken || !(await constantTimeEqual(provided, identity.csrfToken))) {
    throw new AppError(ErrorCodes.FORBIDDEN, "Invalid CSRF token");
  }
}

export function withSetCookies(response: Response, setCookies: string[]): Response {
  if (!setCookies.length) return response;
  const headers = new Headers(response.headers);
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
