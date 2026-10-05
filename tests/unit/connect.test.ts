import { afterEach, describe, expect, it, vi } from "vitest";
import { continueWithOtp, resendOtp, runShopeeLoginFlow } from "../../src/connect/login-flow";
import { handleConnectRoutes, ssoGoneMessage } from "../../src/connect/routes";
import { MAX_BODY_BYTES, readPasteRequest } from "../../src/connect/result-handlers";
import { ErrorCodes } from "../../src/errors/codes";
import type { SaveSessionInput } from "../../src/session/session-store";
import type { ShopeeSessionsStub } from "../../src/session/shopee-session";
import { maskTokenPrefix, type PendingAuthDraft, type PendingAuthState, type StoredCookie, type StoredShopeeSession } from "../../src/session/types";

vi.mock("../../src/connect/login-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connect/login-flow")>();
  return {
    ...actual,
    runShopeeLoginFlow: vi.fn(),
    continueWithOtp: vi.fn(),
    resendOtp: vi.fn(),
  };
});

const PSK = "dev-psk-16-chars-min";
const ORIGIN = "http://localhost:8787";
const HOP_PATHS = ["/connect/authorize", "/connect/callback", "/connect/sso", "/connect/picker"] as const;
const GONE =
  "SSO Google/Facebook/Apple dan otorisasi Open Platform tidak didukung. Masuk dengan HP/email di /connect.";

function cookie(name: string, value: string): StoredCookie {
  return { name, value, domain: "shopee.co.id", hostOnly: true, path: "/" };
}

const BUYER_COOKIES = [cookie("SPC_EC", "ec-value"), cookie("csrftoken", "csrf-token-value")];

const PASTE_BUNDLE = {
  v: 1,
  source: "browser-export",
  cookies: [
    { name: "SPC_EC", value: "ec-value", domain: ".shopee.co.id", path: "/" },
    { name: "csrftoken", value: "csrf-token-value", domain: "shopee.co.id", path: "/" },
    { name: "SPC_U", value: "123456789", domain: ".shopee.co.id", path: "/" },
  ],
};

function sessionsNs() {
  let stored: StoredShopeeSession | null = null;
  let pending: PendingAuthState | null = null;

  const stub: ShopeeSessionsStub = {
    getSession: vi.fn(async () => stored),
    saveSession: vi.fn(async (input: SaveSessionInput) => {
      stored = {
        cookies: input.cookies,
        csrfToken: input.csrfToken,
        connectedAt: Date.now(),
        subject: input.subject,
        source: input.source,
        userId: input.userId,
      };
      pending = null;
      return stored;
    }),
    clear: vi.fn(async () => {
      stored = null;
      pending = null;
    }),
    clearIfFingerprint: vi.fn(async () => false),
    status: vi.fn(async () =>
      stored
        ? {
            connected: true,
            connectedAt: stored.connectedAt,
            source: stored.source,
            cookieCount: stored.cookies.length,
            ...(stored.userId ? { userPrefix: maskTokenPrefix(stored.userId) } : {}),
          }
        : { connected: false },
    ),
    checkRateLimit: vi.fn(async () => ({ ok: true, remaining: 10, retryAfterMs: 0 })),
    savePending: vi.fn(async (draft: PendingAuthDraft) => {
      const now = Date.now();
      pending = { ...draft, createdAt: now, expiresAt: now + 600_000 };
      return pending;
    }),
    getPending: vi.fn(async () => pending),
    takePending: vi.fn(async () => {
      const out = pending;
      pending = null;
      return out;
    }),
    clearPending: vi.fn(async () => {
      pending = null;
    }),
  };

  return {
    ns: {
      idFromName: () => ({ toString: () => "owner" }),
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    stub,
  };
}

function env(ns: DurableObjectNamespace = sessionsNs().ns) {
  return {
    ALLOW_DEV_PSK: "true",
    DEV_PSK: PSK,
    OWNER_PASSWORD: "owner-password-16",
    SHOPEE_SESSIONS: ns,
    REQUIRE_SESSION_ENCRYPTION: "false",
    PUBLIC_BASE_URL: ORIGIN,
  };
}

function req(path: string, init: RequestInit = {}, withPsk = true): Request {
  const headers = new Headers(init.headers);
  if (withPsk) headers.set("x-dev-psk", PSK);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function jsonReq(path: string, init: RequestInit = {}, withPsk = true): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return req(path, { ...init, headers }, withPsk);
}

function streamRequest(bytes: Uint8Array, contentType: string): Request {
  return new Request(`${ORIGIN}/connect/paste`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect hops + owner gate", () => {
  it("documents the 410 copy used by SSO / Open Platform hops", () => {
    expect(ssoGoneMessage()).toBe(GONE);
  });

  it("returns 410 JSON {code,message} for authorize/callback/sso/picker after the PSK gate", async () => {
    const e = env();
    for (const path of HOP_PATHS) {
      const res = await handleConnectRoutes(jsonReq(path), e);
      expect(res?.status, path).toBe(410);
      const body = (await res?.json()) as { code: string; message: string };
      expect(body).toEqual({ code: ErrorCodes.INVALID_INPUT, message: GONE });
    }
  });

  it("returns 410 HTML for /connect/sso after PSK", async () => {
    const { ns, stub } = sessionsNs();
    const html = await handleConnectRoutes(req("/connect/sso"), env(ns));
    expect(html?.status).toBe(410);
    expect(await html?.text()).toContain(GONE);
    expect(stub.saveSession).not.toHaveBeenCalled();
  });

  it("GET /connect/login is 404 after the gate (not a 410 hop)", async () => {
    const res = await handleConnectRoutes(jsonReq("/connect/login"), env());
    expect(res?.status).toBe(404);
  });

  it("gates hops without PSK (410 is after the owner/PSK gate)", async () => {
    const e = env();
    const browser = await handleConnectRoutes(req("/connect/sso", {}, false), e);
    expect(browser?.status).toBe(302);
    expect(browser?.headers.get("location")).toMatch(/^\/login\?next=/);

    const api = await handleConnectRoutes(jsonReq("/connect/sso", {}, false), e);
    expect(api?.status).toBe(401);
    expect(((await api?.json()) as { code: string }).code).toBe(ErrorCodes.UNAUTHORIZED);
  });

  it("GET /connect/callback is not exempt from the owner/PSK gate", async () => {
    const e = env();
    const json = await handleConnectRoutes(jsonReq("/connect/callback?code=x", {}, false), e);
    expect(json?.status).toBe(401);
    expect(((await json?.json()) as { code: string }).code).toBe(ErrorCodes.UNAUTHORIZED);

    const html = await handleConnectRoutes(req("/connect/callback?code=x", {}, false), e);
    expect(html?.status).toBe(302);
    expect(html?.headers.get("location")).toMatch(/^\/login\?next=/);
  });
});

describe("GET /connect + login/OTP", () => {
  it("GET /connect shows the login form, or the OTP form when pending", async () => {
    const { ns, stub } = sessionsNs();
    const login = await handleConnectRoutes(req("/connect"), env(ns));
    expect(login?.status).toBe(200);
    expect(await login?.text()).toMatch(/password/i);

    await stub.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", "csrf-token-value")],
      csrfToken: "csrf-token-value",
    });
    const otp = await handleConnectRoutes(req("/connect"), env(ns));
    expect(await otp?.text()).toMatch(/OTP|otp|kode/i);
  });

  it("POST /connect/login saves a connected session without returning cookies", async () => {
    vi.mocked(runShopeeLoginFlow).mockResolvedValue({
      kind: "connected",
      cookies: BUYER_COOKIES,
      csrfToken: "csrf-token-value",
      userId: "123456789",
    });
    const { ns, stub } = sessionsNs();
    const res = await handleConnectRoutes(
      jsonReq("/connect/login", {
        method: "POST",
        body: JSON.stringify({ username: "buyer@example.com", password: "s3cret-pass" }),
      }),
      env(ns),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, source: "login", cookieCount: 2, userPrefix: "1234…" });
    expect(JSON.stringify(body)).not.toContain("ec-value");
    expect(JSON.stringify(body)).not.toContain("s3cret-pass");
    expect(stub.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ source: "login", userId: "123456789", cookies: BUYER_COOKIES }),
    );
  });

  it("POST /connect/login needs_otp stores pending without a password", async () => {
    vi.mocked(runShopeeLoginFlow).mockResolvedValue({
      kind: "needs_otp",
      message: "Masukkan OTP",
      pending: {
        step: "otp",
        username: "buyer@example.com",
        cookies: [cookie("csrftoken", "csrf-token-value")],
        csrfToken: "csrf-token-value",
      },
    });
    const { ns, stub } = sessionsNs();
    const res = await handleConnectRoutes(
      jsonReq("/connect/login", {
        method: "POST",
        body: JSON.stringify({ username: "buyer@example.com", password: "s3cret-pass" }),
      }),
      env(ns),
    );
    expect(await res?.json()).toEqual({ needs_otp: true, username: "buyer@example.com" });
    expect(stub.savePending).toHaveBeenCalledTimes(1);
    const draft = vi.mocked(stub.savePending).mock.calls[0]![0];
    expect(draft).not.toHaveProperty("password");
    expect(JSON.stringify(draft)).not.toContain("s3cret-pass");
  });

  it("POST /connect/login needs_paste does not save a session", async () => {
    vi.mocked(runShopeeLoginFlow).mockResolvedValue({
      kind: "needs_paste",
      reason: "captcha",
    });
    const { ns, stub } = sessionsNs();
    const res = await handleConnectRoutes(
      jsonReq("/connect/login", {
        method: "POST",
        body: JSON.stringify({ username: "a@b.co", password: "x" }),
      }),
      env(ns),
    );
    expect(await res?.json()).toEqual({ needs_paste: true, reason: "captcha" });
    expect(stub.saveSession).not.toHaveBeenCalled();
  });

  it("OTP 429 does not consume pending", async () => {
    const { ns, stub } = sessionsNs();
    await stub.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", "csrf-token-value")],
    });
    vi.mocked(stub.checkRateLimit).mockResolvedValue({ ok: false, remaining: 0, retryAfterMs: 60_000 });
    const res = await handleConnectRoutes(
      jsonReq("/connect/otp", { method: "POST", body: JSON.stringify({ vcode: "123456" }) }),
      env(ns),
    );
    expect(res?.status).toBe(429);
    expect(((await res?.json()) as { code: string }).code).toBe(ErrorCodes.SHOPEE_RATE_LIMITED);
    expect(stub.takePending).not.toHaveBeenCalled();
    expect(await stub.getPending()).toMatchObject({ username: "buyer@example.com" });
    expect(continueWithOtp).not.toHaveBeenCalled();
  });

  it("POST /connect/otp consumes pending then continues", async () => {
    vi.mocked(continueWithOtp).mockResolvedValue({
      kind: "connected",
      cookies: BUYER_COOKIES,
      csrfToken: "csrf-token-value",
      userId: "123456789",
    });
    const { ns, stub } = sessionsNs();
    await stub.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", "csrf-token-value")],
      csrfToken: "csrf-token-value",
    });
    const res = await handleConnectRoutes(
      jsonReq("/connect/otp", { method: "POST", body: JSON.stringify({ vcode: "123456" }) }),
      env(ns),
    );
    expect(await res?.json()).toMatchObject({ connected: true, source: "login" });
    expect(stub.takePending).toHaveBeenCalledTimes(1);
    expect(continueWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ vcode: "123456", pending: expect.objectContaining({ username: "buyer@example.com" }) }),
    );
  });

  it("POST /connect/otp/resend keeps pending", async () => {
    vi.mocked(resendOtp).mockResolvedValue({
      kind: "needs_otp",
      message: "otp sent",
      pending: {
        step: "otp",
        username: "buyer@example.com",
        cookies: [cookie("csrftoken", "csrf-token-value")],
      },
    });
    const { ns, stub } = sessionsNs();
    await stub.savePending({
      step: "otp",
      username: "buyer@example.com",
      cookies: [cookie("csrftoken", "csrf-token-value")],
    });
    const res = await handleConnectRoutes(
      jsonReq("/connect/otp/resend", { method: "POST", body: JSON.stringify({}) }),
      env(ns),
    );
    expect(await res?.json()).toEqual({ needs_otp: true, username: "buyer@example.com" });
    expect(stub.takePending).not.toHaveBeenCalled();
  });
});

describe("paste + status + disconnect", () => {
  it("POST /connect/paste saves cookies and SPC_U userId; JSON never returns cookies", async () => {
    const { ns, stub } = sessionsNs();
    const res = await handleConnectRoutes(
      jsonReq("/connect/paste", { method: "POST", body: JSON.stringify(PASTE_BUNDLE) }),
      env(ns),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, source: "paste", userPrefix: "1234…" });
    expect(JSON.stringify(body)).not.toContain("ec-value");
    expect(stub.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "paste",
        userId: "123456789",
        csrfToken: "csrf-token-value",
      }),
    );
  });

  it("GET /connect/status omits cookies", async () => {
    const { ns, stub } = sessionsNs();
    await stub.saveSession({
      cookies: BUYER_COOKIES,
      csrfToken: "csrf-token-value",
      subject: "owner",
      source: "paste",
      userId: "123456789",
    });
    const res = await handleConnectRoutes(jsonReq("/connect/status"), env(ns));
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ connected: true, source: "paste", userPrefix: "1234…" });
    expect(JSON.stringify(body)).not.toContain("ec-value");
    expect(body).not.toHaveProperty("cookies");
  });

  it("POST /connect/disconnect clears session+pending", async () => {
    const { ns, stub } = sessionsNs();
    await stub.saveSession({
      cookies: BUYER_COOKIES,
      subject: "owner",
      source: "login",
    });
    const res = await handleConnectRoutes(
      jsonReq("/connect/disconnect", { method: "POST", body: JSON.stringify({}) }),
      env(ns),
    );
    expect(await res?.json()).toEqual({ connected: false });
    expect(stub.clear).toHaveBeenCalledTimes(1);
  });

  it("readPasteRequest accepts a bundle object or wrapped tokens/bundle", async () => {
    const direct = await readPasteRequest(
      new Request("http://localhost/connect/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PASTE_BUNDLE),
      }),
    );
    expect(direct.bundle).toMatchObject({ v: 1, source: "browser-export" });
    expect(direct).not.toHaveProperty("tokens");

    const wrapped = await readPasteRequest(
      new Request("http://localhost/connect/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csrf: "abc", bundle: PASTE_BUNDLE }),
      }),
    );
    expect(wrapped.csrf).toBe("abc");
    expect(wrapped.bundle).toEqual(PASTE_BUNDLE);

    const tokens = await readPasteRequest(
      new Request("http://localhost/connect/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: PASTE_BUNDLE }),
      }),
    );
    expect(tokens.bundle).toEqual(PASTE_BUNDLE);
  });

  it("caps paste bodies at 256_000 bytes", async () => {
    expect(MAX_BODY_BYTES).toBe(256_000);
    const tooBig = new Uint8Array(MAX_BODY_BYTES + 1);
    await expect(
      readPasteRequest(streamRequest(tooBig, "application/json")),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT, message: "Request body too large" });
  });
});
