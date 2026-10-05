import { DurableObject } from "cloudflare:workers";
import { SessionStore, type SaveSessionInput } from "./session-store";
import type { PendingAuthDraft, PendingAuthState, ShopeeSessionPublicStatus, StoredShopeeSession } from "./types";

export type { SaveSessionInput } from "./session-store";

/**
 * Single-tenant Durable Object holding the operator's Shopee buyer cookie jar
 * (`idFromName("owner")`), plus rate-limit buckets for other named instances.
 *
 * Never log cookies, CSRF, password, or OTP.
 */
export class ShopeeSessionsDO extends DurableObject<Env> {
  #store: SessionStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new SessionStore(ctx.storage, env, ctx.id.toString());
  }

  getSession(): Promise<StoredShopeeSession | null> {
    return this.#store.getSession();
  }

  saveSession(input: SaveSessionInput): Promise<StoredShopeeSession> {
    return this.#store.saveSession(input);
  }

  clear(): Promise<void> {
    return this.#store.clear();
  }

  clearIfFingerprint(fingerprint: string): Promise<boolean> {
    return this.#store.clearIfFingerprint(fingerprint);
  }

  savePending(draft: PendingAuthDraft): Promise<PendingAuthState> {
    return this.#store.savePending(draft);
  }

  getPending(): Promise<PendingAuthState | null> {
    return this.#store.getPending();
  }

  takePending(): Promise<PendingAuthState | null> {
    return this.#store.takePending();
  }

  clearPending(): Promise<void> {
    return this.#store.clearPending();
  }

  status(): Promise<ShopeeSessionPublicStatus> {
    return this.#store.status();
  }

  checkRateLimit(input: {
    key: string;
    limit?: number;
    windowMs?: number;
    peek?: boolean;
  }): Promise<{ ok: boolean; remaining: number; retryAfterMs: number }> {
    return this.#store.checkRateLimit(input);
  }

  override alarm(): Promise<void> {
    return this.#store.alarm();
  }
}
