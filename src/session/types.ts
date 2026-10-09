/**
 * Upstream Shopee buyer session (cookie jar, not Open Platform tokens).
 * Never holds the owner password, OTP, or partner_key.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case host (host-only) or domain without the leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Epoch ms; absent for session cookies. */
  expiresAt?: number;
}

export interface StoredShopeeSession {
  cookies: StoredCookie[];
  csrfToken?: string;
  connectedAt: number;
  subject: string;
  source: "login" | "paste";
  /** Buyer id when a session cookie exposes it (status only; not a secret). */
  userId?: string;
}

export interface ShopeeSessionContext extends StoredShopeeSession {
  /**
   * SHA-256 of connectedAt + sorted name=value cookies.
   * Used for compare-and-delete after upstream login-redirect / 401.
   * A session saved after the failing request started must survive.
   */
  fingerprint: string;
}

export interface ShopeeSessionPublicStatus {
  connected: boolean;
  region?: string;
  connectedAt?: number;
  source?: "login" | "paste";
  userPrefix?: string;
  cookieCount?: number;
}

export interface ShopeeSessionProvider {
  getSession(): Promise<ShopeeSessionContext>;
  /**
   * Mark the session invalid after upstream 401 / login-HTML / login-redirect.
   * With `failedFingerprint`, only a stored session still holding that fingerprint
   * is cleared (a session saved after the failing request started survives).
   */
  markExpired(failedFingerprint?: string): void | Promise<void>;
}

/**
 * Last headed-browser pull of purchase history. Separate Durable Object key from
 * the cookie jar so a 401 fingerprint-clear does not drop the snapshot.
 * Never holds cookies or passwords.
 */
export interface StoredOrdersSnapshot {
  pulledAt: number;
  source: "browser-export";
  list: unknown[];
  details: Record<string, unknown>;
}

/**
 * Short-lived OTP state between /connect/login and /connect/otp.
 * Never holds the password: the owner re-enters it on a fresh login.
 */
export interface PendingAuthState {
  step: "otp";
  /** Normalized email or phone. */
  username: string;
  cookies: StoredCookie[];
  csrfToken?: string;
  createdAt: number;
  expiresAt: number;
}

export type PendingAuthDraft = Omit<PendingAuthState, "createdAt" | "expiresAt">;

export function maskTokenPrefix(token: string): string {
  if (token.length < 4) return "****";
  return `${token.slice(0, 4)}…`;
}
