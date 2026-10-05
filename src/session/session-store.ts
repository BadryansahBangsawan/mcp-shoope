import { AppError, ErrorCodes } from "../errors/codes";
import { isStoredCookie, MAX_COOKIES } from "../connect/cookie-jar";
import { log } from "../observability/log";
import {
  decryptJson,
  encryptJson,
  resolveSessionCrypto,
  sha256Hex,
  type SessionCryptoEnv,
  type SessionKeys,
} from "./crypto";
import type {
  PendingAuthDraft,
  PendingAuthState,
  ShopeeSessionPublicStatus,
  StoredShopeeSession,
} from "./types";
import { maskTokenPrefix } from "./types";

const SESSION_KEY = "session";
const PENDING_KEY = "pending_auth";
const RATE_PREFIX = "rate:";
export const PENDING_TTL_MS = 10 * 60_000;

type RecordKind = "session" | "pending";

interface SealedRecord {
  v: 2;
  kind: RecordKind;
  exp: number | null;
  iv: string;
  ct: string;
}

interface PlainRecord {
  v: 2;
  kind: RecordKind;
  exp: number | null;
  plain: unknown;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

export interface SaveSessionInput {
  cookies: StoredShopeeSession["cookies"];
  csrfToken?: string;
  subject: string;
  source: "login" | "paste";
  userId?: string;
}

export type SessionStoreEnv = SessionCryptoEnv & {
  SHOPEE_REGION?: string;
};

/** The subset of DurableObjectStorage the store needs (lets tests use an in-memory map). */
export interface SessionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

function isV2Record(raw: unknown): raw is SealedRecord | PlainRecord {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Partial<SealedRecord & PlainRecord>;
  return (
    r.v === 2 &&
    (r.kind === "session" || r.kind === "pending") &&
    (r.exp === null || typeof r.exp === "number")
  );
}

function sameRecord(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function hasPassword(v: object): boolean {
  return "password" in v && (v as { password?: unknown }).password !== undefined;
}

function isStoredSession(v: unknown): v is StoredShopeeSession {
  if (!v || typeof v !== "object") return false;
  if (hasPassword(v)) return false;
  const s = v as Partial<StoredShopeeSession> & { access_token?: unknown };
  if (typeof s.access_token === "string") return false;
  return (
    Array.isArray(s.cookies) &&
    s.cookies.length >= 1 &&
    s.cookies.length <= MAX_COOKIES &&
    s.cookies.every(isStoredCookie) &&
    typeof s.connectedAt === "number" &&
    typeof s.subject === "string" &&
    (s.source === "login" || s.source === "paste") &&
    (s.csrfToken === undefined || typeof s.csrfToken === "string") &&
    (s.userId === undefined || typeof s.userId === "string")
  );
}

function isPending(v: unknown): v is PendingAuthState {
  if (!v || typeof v !== "object") return false;
  if (hasPassword(v)) return false;
  const p = v as Partial<PendingAuthState>;
  return (
    p.step === "otp" &&
    typeof p.username === "string" &&
    p.username.length > 0 &&
    Array.isArray(p.cookies) &&
    p.cookies.length <= MAX_COOKIES &&
    p.cookies.every(isStoredCookie) &&
    typeof p.createdAt === "number" &&
    typeof p.expiresAt === "number" &&
    (p.csrfToken === undefined || typeof p.csrfToken === "string")
  );
}

/**
 * Hash of connectedAt + sorted name=value cookies. A reconnect (new jar or
 * connectedAt) gets a new fingerprint so an in-flight 401 cannot
 * compare-and-delete a session saved after the failing request started.
 */
export async function sessionFingerprint(session: StoredShopeeSession): Promise<string> {
  const sorted = [...session.cookies]
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join("&");
  return sha256Hex(`v2|${session.connectedAt}|${sorted}`);
}

/**
 * Buyer cookie storage for the single-owner ShopeeSessionsDO.
 *
 * - Cookie records are AES-GCM encrypted; AAD binds each blob to this DO id,
 *   storage key, kind and plaintext expiry.
 * - Pending OTP never holds a password.
 * - REQUIRE_SESSION_ENCRYPTION=true rejects plaintext records on read.
 */
export class SessionStore {
  #storage: SessionStorage;
  #env: SessionStoreEnv;
  #scope: string;
  #keyCache: { raw: string | undefined; keys: Promise<SessionKeys> } | undefined;

  constructor(storage: SessionStorage, env: SessionStoreEnv, scope: string) {
    this.#storage = storage;
    this.#env = env;
    this.#scope = scope;
  }

  async getSession(): Promise<StoredShopeeSession | null> {
    await this.#sweepPending();
    return this.#read(SESSION_KEY, "session", isStoredSession);
  }

  async saveSession(input: SaveSessionInput): Promise<StoredShopeeSession> {
    if (!Array.isArray(input.cookies) || input.cookies.length < 1 || input.cookies.length > MAX_COOKIES) {
      throw new AppError(ErrorCodes.INVALID_INPUT, `Session needs 1–${MAX_COOKIES} cookies`);
    }
    if (!input.cookies.every(isStoredCookie)) {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Session cookies are malformed");
    }
    if (input.source !== "login" && input.source !== "paste") {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Session source must be login or paste");
    }
    const record: StoredShopeeSession = {
      cookies: input.cookies.map((c) => ({ ...c })),
      connectedAt: Date.now(),
      subject: input.subject,
      source: input.source,
    };
    if (input.csrfToken) record.csrfToken = input.csrfToken;
    if (input.userId) record.userId = input.userId;
    await this.#write(SESSION_KEY, "session", record, null);
    await this.clearPending();
    return record;
  }

  async clear(): Promise<void> {
    await this.#storage.delete(SESSION_KEY);
    await this.#storage.delete(PENDING_KEY);
  }

  /** Compare-and-delete: clears the session only if it still has this fingerprint. */
  async clearIfFingerprint(fingerprint: string): Promise<boolean> {
    const before = await this.#storage.get(SESSION_KEY);
    const session = await this.#read(SESSION_KEY, "session", isStoredSession);
    if (!session) return false;
    if ((await sessionFingerprint(session)) !== fingerprint.toLowerCase()) return false;
    if (!sameRecord(before, await this.#storage.get(SESSION_KEY))) return false;
    await this.#storage.delete(SESSION_KEY);
    log("info", "session.cleared_after_upstream_auth", { cookieCount: session.cookies.length });
    return true;
  }

  async savePending(draft: PendingAuthDraft): Promise<PendingAuthState> {
    if (draft.step !== "otp") {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Pending auth step must be otp");
    }
    const username = draft.username.trim();
    if (!username) {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Pending username is required");
    }
    if (!Array.isArray(draft.cookies) || draft.cookies.length > MAX_COOKIES || !draft.cookies.every(isStoredCookie)) {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Pending cookies are malformed");
    }
    const now = Date.now();
    const record: PendingAuthState = {
      step: "otp",
      username,
      cookies: draft.cookies.map((c) => ({ ...c })),
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    };
    if (draft.csrfToken) record.csrfToken = draft.csrfToken;
    await this.#write(PENDING_KEY, "pending", record, record.expiresAt);
    await this.#scheduleAlarm(record.expiresAt);
    return record;
  }

  async getPending(): Promise<PendingAuthState | null> {
    return this.#read(PENDING_KEY, "pending", isPending);
  }

  /** Consume pending OTP state (success and failure). */
  async takePending(): Promise<PendingAuthState | null> {
    const pending = await this.#read(PENDING_KEY, "pending", isPending);
    if (!pending) return null;
    await this.#storage.delete(PENDING_KEY);
    return pending;
  }

  async clearPending(): Promise<void> {
    await this.#storage.delete(PENDING_KEY);
  }

  async status(): Promise<ShopeeSessionPublicStatus> {
    const s = await this.getSession();
    const region = this.#env.SHOPEE_REGION?.trim() || undefined;
    if (!s) {
      return { connected: false, ...(region ? { region } : {}) };
    }
    return {
      connected: true,
      region,
      connectedAt: s.connectedAt,
      source: s.source,
      cookieCount: s.cookies.length,
      ...(s.userId ? { userPrefix: maskTokenPrefix(s.userId) } : {}),
    };
  }

  /**
   * Fixed-window rate limit: max `limit` hits per `windowMs` for a key.
   * Keys are stored as SHA-256 hashes so IPs never sit at rest.
   */
  async checkRateLimit(input: {
    key: string;
    limit?: number;
    windowMs?: number;
    peek?: boolean;
  }): Promise<{ ok: boolean; remaining: number; retryAfterMs: number }> {
    const limit = input.limit ?? 5;
    const windowMs = input.windowMs ?? 15 * 60_000;
    const storageKey = `${RATE_PREFIX}${await sha256Hex(input.key)}`;
    const now = Date.now();
    const stored = await this.#storage.get<RateEntry>(storageKey);
    const entry: RateEntry =
      stored && stored.resetAt > now ? { ...stored } : { count: 0, resetAt: now + windowMs };
    if (entry.count >= limit) {
      return { ok: false, remaining: 0, retryAfterMs: Math.max(0, entry.resetAt - now) };
    }
    if (input.peek) return { ok: true, remaining: limit - entry.count, retryAfterMs: 0 };
    entry.count += 1;
    await this.#storage.put(storageKey, entry);
    await this.#scheduleAlarm(entry.resetAt);
    return { ok: true, remaining: Math.max(0, limit - entry.count), retryAfterMs: 0 };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = await this.#sweepPending(now);
    const rates = await this.#storage.list<RateEntry>({ prefix: RATE_PREFIX });
    for (const [key, entry] of rates) {
      if (!entry || typeof entry.resetAt !== "number" || entry.resetAt <= now) {
        await this.#storage.delete(key);
      } else {
        next = next === null ? entry.resetAt : Math.min(next, entry.resetAt);
      }
    }
    if (next !== null) await this.#storage.setAlarm(next);
  }

  async #sweepPending(now = Date.now()): Promise<number | null> {
    const pending = await this.#read(PENDING_KEY, "pending", isPending);
    if (!pending) return null;
    if (pending.expiresAt <= now) {
      await this.#storage.delete(PENDING_KEY);
      return null;
    }
    return pending.expiresAt;
  }

  async #crypto(): Promise<{ keys: SessionKeys | null; require: boolean }> {
    const raw = this.#env.SESSION_ENCRYPTION_KEY?.trim();
    if (!raw) return resolveSessionCrypto(this.#env);
    let entry = this.#keyCache;
    if (entry?.raw !== raw) {
      entry = { raw, keys: resolveSessionCrypto(this.#env).then((r) => r.keys!) };
      this.#keyCache = entry;
    }
    try {
      return { keys: await entry.keys, require: this.#env.REQUIRE_SESSION_ENCRYPTION === "true" };
    } catch (err) {
      this.#keyCache = undefined;
      throw err;
    }
  }

  #aad(storageKey: string, kind: RecordKind, exp: number | null): string {
    return `sp-shopee-sessions|${this.#scope}|${storageKey}|${kind}|exp=${exp ?? ""}`;
  }

  async #seal(
    storageKey: string,
    kind: RecordKind,
    value: unknown,
    exp: number | null,
  ): Promise<SealedRecord | PlainRecord> {
    const { keys } = await this.#crypto();
    return keys
      ? { v: 2, kind, exp, ...(await encryptJson(keys.aead, value, this.#aad(storageKey, kind, exp))) }
      : { v: 2, kind, exp, plain: value };
  }

  async #write(storageKey: string, kind: RecordKind, value: unknown, exp: number | null): Promise<void> {
    await this.#storage.put(storageKey, await this.#seal(storageKey, kind, value, exp));
  }

  async #drop(storageKey: string, reason: string): Promise<undefined> {
    await this.#storage.delete(storageKey);
    log("warn", "session.record_dropped", { key: storageKey, reason });
    return undefined;
  }

  async #read<T>(
    storageKey: string,
    kind: RecordKind,
    isShape: (v: unknown) => v is T,
  ): Promise<T | null> {
    const raw = await this.#storage.get(storageKey);
    if (raw === undefined) return null;
    const now = Date.now();
    if (isV2Record(raw) && raw.exp !== null && raw.exp <= now) {
      await this.#storage.delete(storageKey);
      return null;
    }
    const { keys, require } = await this.#crypto();
    const value = await this.#open(storageKey, kind, raw, keys, require);
    if (value === undefined) return null;
    if (!isShape(value)) {
      await this.#drop(storageKey, "malformed");
      return null;
    }
    return value;
  }

  async #open(
    storageKey: string,
    kind: RecordKind,
    raw: unknown,
    keys: SessionKeys | null,
    require: boolean,
  ): Promise<unknown> {
    if (isV2Record(raw)) {
      if (raw.kind !== kind) return this.#drop(storageKey, "kind_mismatch");
      if ("plain" in raw) {
        if (require) return this.#drop(storageKey, "plaintext_rejected");
        return raw.plain;
      }
      if (!keys) return undefined;
      try {
        return await decryptJson<unknown>(keys.aead, raw, this.#aad(storageKey, kind, raw.exp));
      } catch {
        return this.#drop(storageKey, "decrypt_failed");
      }
    }
    return this.#drop(storageKey, "unsupported_record");
  }

  async #scheduleAlarm(at: number): Promise<void> {
    const current = await this.#storage.getAlarm();
    if (current === null || current > at) await this.#storage.setAlarm(at);
  }
}
