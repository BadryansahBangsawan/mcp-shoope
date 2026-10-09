import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../src/errors/codes";
import { sha256Hex } from "../../src/session/crypto";
import {
  PENDING_TTL_MS,
  SessionStore,
  sessionFingerprint,
  type SaveSessionInput,
  type SessionStorage,
} from "../../src/session/session-store";
import type { StoredCookie, StoredShopeeSession } from "../../src/session/types";

const ENC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const EC = "ec-secret-value";
const CSRF = "csrf-secret-value";

class MemoryStorage implements SessionStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
}

function cookie(name: string, value: string, extra: Partial<StoredCookie> = {}): StoredCookie {
  return { name, value, domain: "shopee.co.id", hostOnly: true, path: "/", ...extra };
}

function cookies(ec = EC, csrf = CSRF): StoredCookie[] {
  return [cookie("SPC_EC", ec), cookie("csrftoken", csrf)];
}

function sessionInput(extra: Partial<SaveSessionInput> = {}): SaveSessionInput {
  return {
    cookies: cookies(),
    csrfToken: CSRF,
    subject: "owner",
    source: "login",
    userId: "123456789",
    ...extra,
  };
}

function stored(extra: Partial<StoredShopeeSession> = {}): StoredShopeeSession {
  return {
    cookies: cookies(),
    csrfToken: CSRF,
    connectedAt: 1_700_000_000_000,
    subject: "owner",
    source: "login",
    ...extra,
  };
}

function plainEnv(extra: Record<string, string> = {}) {
  return { REQUIRE_SESSION_ENCRYPTION: "false", ...extra };
}

function store(
  opts: { storage?: MemoryStorage; env?: Record<string, string>; scope?: string } = {},
): { store: SessionStore; storage: MemoryStorage } {
  const storage = opts.storage ?? new MemoryStorage();
  return {
    storage,
    store: new SessionStore(storage, opts.env ?? plainEnv(), opts.scope ?? "test-scope"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sessionFingerprint", () => {
  it("is sha256 of v2|connectedAt|sorted name=value cookies", async () => {
    const session = stored();
    const sorted = [...session.cookies]
      .map((c) => `${c.name}=${c.value}`)
      .sort()
      .join("&");
    const fp = await sessionFingerprint(session);
    expect(fp).toBe(await sha256Hex(`v2|${session.connectedAt}|${sorted}`));
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(fp).not.toContain(EC);
    expect(fp).not.toContain(CSRF);

    expect(await sessionFingerprint({ ...session, csrfToken: "other" })).toBe(fp);
    expect(await sessionFingerprint({ ...session, subject: "other" })).toBe(fp);
    expect(await sessionFingerprint({ ...session, source: "paste" })).toBe(fp);
    expect(await sessionFingerprint({ ...session, cookies: cookies("other-ec") })).not.toBe(fp);
    expect(await sessionFingerprint({ ...session, connectedAt: 2 })).not.toBe(fp);
  });
});

describe("SessionStore save/clear", () => {
  it("constructs with (storage, env, scope)", () => {
    const storage = new MemoryStorage();
    expect(() => new SessionStore(storage, plainEnv(), "owner")).not.toThrow();
  });

  it("saveSession stores cookies and clears pending", async () => {
    const { store: s } = store();
    await s.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", CSRF)],
      csrfToken: CSRF,
    });
    expect(await s.getPending()).not.toBeNull();

    const first = await s.saveSession(sessionInput());
    expect(first.source).toBe("login");
    expect(first.cookies.some((c) => c.name === "SPC_EC" && c.value === EC)).toBe(true);
    expect(first.userId).toBe("123456789");
    expect(await s.getPending()).toBeNull();
    expect((await s.getSession())?.cookies).toHaveLength(2);
  });

  it("rejects empty cookies and leftover HMAC-shaped input", async () => {
    const { store: s } = store();
    await expect(s.saveSession({ ...sessionInput(), cookies: [] })).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
    });
  });

  it("clear() deletes session+pending (no shop lock leftover)", async () => {
    const { store: s, storage } = store();
    await s.saveSession(sessionInput());
    await s.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", CSRF)],
    });
    expect(storage.data.has("session")).toBe(true);
    expect(storage.data.has("pending_auth")).toBe(true);

    await s.clear();
    expect(await s.getSession()).toBeNull();
    expect(await s.takePending()).toBeNull();
    expect(storage.data.has("session")).toBe(false);
    expect(storage.data.has("pending_auth")).toBe(false);
    expect([...storage.data.keys()].every((k) => !k.includes("shop") && !k.includes("lock"))).toBe(true);
  });

  it("clearIfFingerprint compare-and-deletes only the matching session", async () => {
    const { store: s } = store();
    expect(await s.clearIfFingerprint("0".repeat(64))).toBe(false);

    const first = await s.saveSession(sessionInput({ cookies: cookies("first-ec") }));
    const staleFp = await sessionFingerprint(first);
    const second = await s.saveSession(sessionInput({ cookies: cookies("next-ec") }));
    expect(await s.clearIfFingerprint(staleFp)).toBe(false);
    expect((await s.getSession())?.cookies.some((c) => c.value === "next-ec")).toBe(true);
    expect((await s.getSession())?.connectedAt).toBe(second.connectedAt);

    const liveFp = await sessionFingerprint((await s.getSession())!);
    expect(await s.clearIfFingerprint(liveFp)).toBe(true);
    expect(await s.getSession()).toBeNull();
  });

  it("orders snapshot survives fingerprint-clear but not disconnect", async () => {
    const { store: s, storage } = store();
    const snap = {
      pulledAt: 1_778_173_200_000,
      source: "browser-export" as const,
      list: [{ order_id: "123456789012345" }],
      details: { "123456789012345": { order_id: "123456789012345" } },
    };
    await s.saveOrdersSnapshot(snap);
    expect((await s.getOrdersSnapshot())?.list).toHaveLength(1);

    const session = await s.saveSession(sessionInput());
    const fp = await sessionFingerprint(session);
    expect(await s.clearIfFingerprint(fp)).toBe(true);
    expect(await s.getSession()).toBeNull();
    expect((await s.getOrdersSnapshot())?.list).toHaveLength(1);

    await s.clear();
    expect(await s.getOrdersSnapshot()).toBeNull();
    expect(storage.data.has("orders_snapshot")).toBe(false);
  });

  it("status reports cookieCount and userPrefix, never cookies", async () => {
    const { store: s } = store({ env: plainEnv({ SHOPEE_REGION: "ID" }) });
    expect(await s.status()).toEqual({ connected: false, region: "ID" });
    await s.saveSession(sessionInput());
    const st = await s.status();
    expect(st).toMatchObject({
      connected: true,
      region: "ID",
      source: "login",
      cookieCount: 2,
      userPrefix: "1234…",
    });
    expect(JSON.stringify(st)).not.toContain(EC);
    expect(st).not.toHaveProperty("cookies");
  });
});

describe("SessionStore pending", () => {
  it("takePending consumes the single unexpired pending", async () => {
    const { store: s } = store();
    await s.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", CSRF)],
      csrfToken: CSRF,
    });
    const kept = await s.takePending();
    expect(kept).toMatchObject({ step: "otp", username: "buyer@example.com" });
    expect(kept).not.toHaveProperty("password");
    expect(kept?.createdAt).toBeGreaterThan(0);
    expect(await s.takePending()).toBeNull();
  });

  it("PENDING_TTL_MS is 10 minutes; expired pending is dropped", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { store: s, storage } = store();
    await s.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", CSRF)],
    });
    const raw = storage.data.get("pending_auth") as { exp: number | null };
    expect(raw.exp).toBe(1_700_000_000_000 + PENDING_TTL_MS);
    expect(PENDING_TTL_MS).toBe(10 * 60_000);

    vi.setSystemTime(1_700_000_000_000 + PENDING_TTL_MS + 1);
    expect(await s.takePending()).toBeNull();
    expect(storage.data.has("pending_auth")).toBe(false);
  });
});

describe("SessionStore decrypt_failed / malformed", () => {
  it("stores plaintext v2 records when REQUIRE_SESSION_ENCRYPTION=false", async () => {
    const { store: s, storage } = store();
    await s.saveSession(sessionInput());
    expect(storage.data.get("session")).toMatchObject({
      v: 2,
      kind: "session",
      exp: null,
      plain: expect.objectContaining({ source: "login" }),
    });
    expect((await s.getSession())?.cookies.some((c) => c.value === EC)).toBe(true);
  });

  it("REQUIRE_SESSION_ENCRYPTION=true rejects plaintext v2 records", async () => {
    const storage = new MemoryStorage();
    await new SessionStore(storage, plainEnv(), "owner").saveSession(sessionInput());
    const requireEnc = new SessionStore(
      storage,
      { REQUIRE_SESSION_ENCRYPTION: "true", SESSION_ENCRYPTION_KEY: ENC_KEY },
      "owner",
    );
    expect(await requireEnc.getSession()).toBeNull();
    expect(storage.data.has("session")).toBe(false);
  });

  it("drops leftover HMAC blobs and pending that still hold a password", async () => {
    const { store: s, storage } = store();
    storage.data.set("session", {
      v: 2,
      kind: "session",
      exp: null,
      plain: {
        access_token: "leftover-access",
        refresh_token: "leftover-refresh",
        shop_id: "987654321",
        connectedAt: 1,
        subject: "owner",
        source: "oauth",
      },
    });
    expect(await s.getSession()).toBeNull();
    expect(storage.data.has("session")).toBe(false);

    const now = Date.now();
    storage.data.set("pending_auth", {
      v: 2,
      kind: "pending",
      exp: now + PENDING_TTL_MS,
      plain: {
        step: "otp",
        username: "buyer@example.com",
        cookies: [cookie("csrftoken", CSRF)],
        password: "s3cret-pass",
        createdAt: now,
        expiresAt: now + PENDING_TTL_MS,
      },
    });
    expect(await s.getPending()).toBeNull();
    expect(storage.data.has("pending_auth")).toBe(false);
  });

  it("drops malformed records", async () => {
    const { store: s, storage } = store();
    storage.data.set("session", { v: 2, kind: "session", exp: null, plain: { foo: 1 } });
    expect(await s.getSession()).toBeNull();
    expect(storage.data.has("session")).toBe(false);

    storage.data.set("session", { v: 1, iv: "x", ct: "y" });
    expect(await s.getSession()).toBeNull();
    expect(storage.data.has("session")).toBe(false);
  });

  it("drops decrypt_failed records (wrong key / AAD prefix sp-shopee-sessions)", async () => {
    const encEnv = {
      SESSION_ENCRYPTION_KEY: ENC_KEY,
      REQUIRE_SESSION_ENCRYPTION: "true",
    };
    const a = new MemoryStorage();
    await new SessionStore(a, encEnv, "do-a").saveSession(sessionInput());
    const raw = JSON.stringify(a.data.get("session"));
    expect(raw).not.toContain(EC);
    expect(raw).not.toContain(CSRF);
    expect(a.data.get("session")).toMatchObject({ v: 2, kind: "session" });

    const rotated = new SessionStore(
      a,
      { ...encEnv, SESSION_ENCRYPTION_KEY: "rotated-key-rotated-key-rotated" },
      "do-a",
    );
    expect(await rotated.getSession()).toBeNull();
    expect(a.data.has("session")).toBe(false);

    const a2 = new MemoryStorage();
    await new SessionStore(a2, encEnv, "do-a").saveSession(sessionInput());
    const b = new MemoryStorage();
    b.data.set("session", a2.data.get("session"));
    expect(await new SessionStore(b, encEnv, "do-b").getSession()).toBeNull();
    expect(b.data.has("session")).toBe(false);
  });
});

describe("SessionStore rate limit", () => {
  it("hashes keys so IPs are not stored, and peek does not increment", async () => {
    const { store: s, storage } = store();
    const peek = await s.checkRateLimit({
      key: "connect-pin:ip:1.2.3.4",
      limit: 2,
      windowMs: 60_000,
      peek: true,
    });
    expect(peek).toMatchObject({ ok: true, remaining: 2 });
    expect([...storage.data.keys()].some((k) => k.startsWith("rate:"))).toBe(false);

    const first = await s.checkRateLimit({ key: "connect-pin:ip:1.2.3.4", limit: 2, windowMs: 60_000 });
    expect(first).toMatchObject({ ok: true, remaining: 1 });
    const keys = [...storage.data.keys()].filter((k) => k.startsWith("rate:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("1.2.3.4");
    expect(keys[0]).not.toContain("connect-pin");

    await s.checkRateLimit({ key: "connect-pin:ip:1.2.3.4", limit: 2, windowMs: 60_000 });
    const blocked = await s.checkRateLimit({ key: "connect-pin:ip:1.2.3.4", limit: 2, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});
