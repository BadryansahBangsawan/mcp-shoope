import { AppError, ErrorCodes } from "../errors/codes";
import { sessionFingerprint, type SaveSessionInput } from "./session-store";
import type {
  PendingAuthDraft,
  PendingAuthState,
  ShopeeSessionContext,
  ShopeeSessionProvider,
  ShopeeSessionPublicStatus,
  StoredOrdersSnapshot,
  StoredShopeeSession,
} from "./types";

const CONNECT_HINT = "Sambungkan akun di /connect";

/** RPC surface for ShopeeSessionsDO stub (or test mock). */
export interface ShopeeSessionsStub {
  getSession(): Promise<StoredShopeeSession | null>;
  saveSession(input: SaveSessionInput): Promise<StoredShopeeSession>;
  clear(): Promise<void>;
  clearIfFingerprint(fingerprint: string): Promise<boolean>;
  getOrdersSnapshot(): Promise<StoredOrdersSnapshot | null>;
  saveOrdersSnapshot(snapshot: StoredOrdersSnapshot): Promise<StoredOrdersSnapshot>;
  savePending(draft: PendingAuthDraft): Promise<PendingAuthState>;
  getPending(): Promise<PendingAuthState | null>;
  takePending(): Promise<PendingAuthState | null>;
  clearPending(): Promise<void>;
  status(): Promise<ShopeeSessionPublicStatus>;
  checkRateLimit(input: {
    key: string;
    limit?: number;
    windowMs?: number;
    peek?: boolean;
  }): Promise<{ ok: boolean; remaining: number; retryAfterMs: number }>;
}

export interface CompositeSessionOptions {
  sessionsDo: Pick<ShopeeSessionsStub, "getSession" | "clear" | "clearIfFingerprint">;
}

/**
 * Cookie session provider. There is no Open Platform refresh: 401 / login-HTML
 * expire the jar and the owner reconnects.
 */
export class CompositeShopeeSessionProvider implements ShopeeSessionProvider {
  #do: CompositeSessionOptions["sessionsDo"];

  constructor(options: CompositeSessionOptions) {
    this.#do = options.sessionsDo;
  }

  async markExpired(failedFingerprint?: string): Promise<void> {
    if (failedFingerprint === undefined) {
      try {
        await this.#do.clear();
      } catch {
        // next getSession() will surface the problem
      }
      return;
    }
    try {
      await this.#do.clearIfFingerprint(failedFingerprint);
    } catch {
      // DO unavailable: the next getSession() will surface the problem
    }
  }

  async getSession(): Promise<ShopeeSessionContext> {
    let stored: StoredShopeeSession | null;
    try {
      stored = await this.#do.getSession();
    } catch {
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, CONNECT_HINT);
    }
    if (!stored) {
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, CONNECT_HINT);
    }
    return { ...stored, fingerprint: await sessionFingerprint(stored) };
  }
}

/** One shared Shopee session for this single-tenant Worker. */
export function sessionsDoForOwner(ns: DurableObjectNamespace): ShopeeSessionsStub & DurableObjectStub {
  return ns.get(ns.idFromName("owner")) as ShopeeSessionsStub & DurableObjectStub;
}
