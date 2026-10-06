import { describe, expect, it, vi } from "vitest";
import {
  LOGIN_PAGE_URL,
  LOGIN_URL,
  RESEND_OTP_URL,
  VCODE_LOGIN_URL,
  continueWithOtp,
  resendOtp,
  runShopeeLoginFlow,
} from "../../src/connect/login-flow";
import {
  isOtpHint,
  isValidOtp,
  normalizeUsername,
  parseLoginJson,
} from "../../src/connect/login-parse";
import { sha256Hex } from "../../src/session/crypto";
import type { PendingAuthState, StoredCookie } from "../../src/session/types";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function html(body: string, status = 200, setCookie: string[] = []): Response {
  const headers = new Headers({ "content-type": "text/html" });
  for (const c of setCookie) headers.append("set-cookie", c);
  return new Response(body, { status, headers });
}

function json(body: unknown, status = 200, setCookie: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookie) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function cookie(name: string, value: string): StoredCookie {
  return { name, value, domain: "shopee.co.id", hostOnly: true, path: "/" };
}

function pending(extra: Partial<PendingAuthState> = {}): PendingAuthState {
  const now = Date.now();
  return {
    step: "otp",
    username: "buyer@example.com",
    cookies: [cookie("csrftoken", "csrf-token-value")],
    csrfToken: "csrf-token-value",
    createdAt: now,
    expiresAt: now + 600_000,
    ...extra,
  };
}

function loginPageOk(setCookie = ["csrftoken=csrf-token-value; Path=/; Domain=.shopee.co.id"]): Response {
  return html("<html><body>login</body></html>", 200, setCookie);
}

describe("normalizeUsername / OTP", () => {
  it("lowercases email and normalizes ID phones to 62…", () => {
    expect(normalizeUsername(" Buyer@Example.COM ")).toBe("buyer@example.com");
    expect(normalizeUsername("081234567890")).toBe("6281234567890");
    expect(normalizeUsername("+62 812-3456-7890")).toBe("6281234567890");
    expect(normalizeUsername("6281234567890")).toBe("6281234567890");
    expect(normalizeUsername("")).toBe("");
  });

  it("accepts 4–8 alphanumeric OTP", () => {
    expect(isValidOtp("1234")).toBe(true);
    expect(isValidOtp("Ab12Cd")).toBe(true);
    expect(isValidOtp("123")).toBe(false);
    expect(isValidOtp("123456789")).toBe(false);
    expect(isValidOtp("12 34")).toBe(false);
  });

  it("parseLoginJson reads error/error_code and message aliases", () => {
    expect(parseLoginJson({ error: 0, msg: "ok" })).toMatchObject({ error: 0, message: "ok" });
    expect(parseLoginJson({ error_code: "need_otp", error_msg: "verify" })).toMatchObject({
      error: "need_otp",
      message: "verify",
    });
  });

  it("OTP hint is otp/vcode/ivs, not a generic verify", () => {
    expect(isOtpHint("error_need_otp", "please verify")).toBe(true);
    expect(isOtpHint("need_vcode", "")).toBe(true);
    expect(isOtpHint("error_ivs", "")).toBe(true);
    expect(isOtpHint("ivs", "challenge")).toBe(true);
    expect(isOtpHint("error_password", "Please verify your password")).toBe(false);
    expect(isOtpHint("error_param", "invalid")).toBe(false);
  });
});

describe("runShopeeLoginFlow", () => {
  it("GET login 403 or 3xx → needs_paste without posting password", async () => {
    for (const status of [403, 302, 301]) {
      const fetchImpl = vi.fn<FetchLike>(async () => html("blocked", status));
      const result = await runShopeeLoginFlow({
        username: "buyer@example.com",
        password: "s3cret-pass",
        fetchImpl,
      });
      expect(result.kind, String(status)).toBe("needs_paste");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]![0])).toBe(LOGIN_PAGE_URL);
    }
  });

  it("captcha/anti-bot on the login page → needs_paste", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => html("<html>captcha slider unusual traffic</html>"));
    const result = await runShopeeLoginFlow({
      username: "buyer@example.com",
      password: "s3cret-pass",
      fetchImpl,
    });
    expect(result.kind).toBe("needs_paste");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("OTP envelope → needs_otp pending without a password", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      return json({ error: "error_need_otp", message: "Please verify OTP via sms" });
    });
    const result = await runShopeeLoginFlow({
      username: "Buyer@Example.COM",
      password: "s3cret-pass",
      fetchImpl,
    });
    expect(result.kind).toBe("needs_otp");
    if (result.kind !== "needs_otp") throw new Error("expected needs_otp");
    expect(result.pending.step).toBe("otp");
    expect(result.pending.username).toBe("buyer@example.com");
    expect(result.pending).not.toHaveProperty("password");
    expect(JSON.stringify(result.pending)).not.toContain("s3cret-pass");
  });

  it("success with SPC_EC + error 0 hashes the password and never sends plaintext", async () => {
    const hash = await sha256Hex("s3cret-pass");
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      expect(String(input)).toBe(LOGIN_URL);
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("x-csrftoken")).toBe("csrf-token-value");
      expect(headers.get("cookie")).toContain("csrftoken=csrf-token-value");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.username).toBe("buyer@example.com");
      expect(body.password).toBe(hash);
      expect(body.password).not.toBe("s3cret-pass");
      expect(body.support_ivs).toBe(true);
      expect(JSON.stringify(body)).not.toContain("s3cret-pass");
      return json({ error: 0, data: {} }, 200, ["SPC_EC=session-ec; Path=/", "SPC_U=123456789; Path=/"]);
    });
    const result = await runShopeeLoginFlow({
      username: "buyer@example.com",
      password: "s3cret-pass",
      fetchImpl,
    });
    expect(result).toMatchObject({
      kind: "connected",
      csrfToken: "csrf-token-value",
      userId: "123456789",
    });
    if (result.kind !== "connected") throw new Error("expected connected");
    expect(result.cookies.some((c) => c.name === "SPC_EC" && c.value === "session-ec")).toBe(true);
  });

  it("reads CSRF from HTML meta when the cookie is missing", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      if (String(input) === LOGIN_PAGE_URL) {
        return html('<html><meta name="csrf-token" content="htmlcsrf99"></html>');
      }
      const headers = new Headers(init.headers);
      expect(headers.get("x-csrftoken")).toBe("htmlcsrf99");
      return json({ error: "", data: {} }, 200, ["SPC_ST=st-value; Path=/"]);
    });
    const result = await runShopeeLoginFlow({
      username: "081234567890",
      password: "s3cret-pass",
      fetchImpl,
    });
    expect(result.kind).toBe("connected");
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1].body)) as { username: string };
    expect(body.username).toBe("6281234567890");
  });

  it("password failure that says verify is an error, not needs_otp", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      return json({ error: "error_password", message: "Please verify your password" });
    });
    const result = await runShopeeLoginFlow({ username: "a@b.co", password: "x", fetchImpl });
    expect(result.kind).toBe("error");
  });

  it("password JSON with an ivs key is error, not needs_otp", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      return json({
        error: "error_password",
        message: "wrong password",
        data: { ivs: { token: "x" } },
      });
    });
    const result = await runShopeeLoginFlow({ username: "a@b.co", password: "x", fetchImpl });
    expect(result.kind).toBe("error");
  });

  it("login JSON captcha → needs_paste; 429 keeps the error status", async () => {
    const captcha = vi.fn<FetchLike>(async (input) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      return json({ error: "error_captcha", message: "captcha required" });
    });
    expect((await runShopeeLoginFlow({ username: "a@b.co", password: "x", fetchImpl: captcha })).kind).toBe(
      "needs_paste",
    );

    const limited = vi.fn<FetchLike>(async (input) => {
      if (String(input) === LOGIN_PAGE_URL) return loginPageOk();
      return json({ error: "too_many" }, 429);
    });
    const limitedResult = await runShopeeLoginFlow({
      username: "a@b.co",
      password: "x",
      fetchImpl: limited,
    });
    expect(limitedResult).toMatchObject({ kind: "error", status: 429 });
  });
});

describe("continueWithOtp / resendOtp", () => {
  it("POSTs vcode_login and connects when SPC_EC is set", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      expect(String(input)).toBe(VCODE_LOGIN_URL);
      expect(JSON.parse(String(init.body))).toMatchObject({
        username: "buyer@example.com",
        vcode: "123456",
        support_ivs: true,
      });
      return json({ error: 0 }, 200, ["SPC_EC=ec-after-otp; Path=/"]);
    });
    const result = await continueWithOtp({ pending: pending(), vcode: "123456", fetchImpl });
    expect(result.kind).toBe("connected");
  });

  it("OTP success that still hints OTP is an error, not another pending", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: "error_need_otp", message: "verify again" }));
    const result = await continueWithOtp({ pending: pending(), vcode: "123456", fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/OTP salah/);
  });

  it("resend posts to resend_otp", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      expect(String(input)).toBe(RESEND_OTP_URL);
      return json({ error: "need_otp", message: "otp sent" });
    });
    const result = await resendOtp({ pending: pending(), fetchImpl });
    expect(result.kind).toBe("needs_otp");
  });

  it("resend success without session cookies keeps OTP pending", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ error: 0, data: {} }));
    const result = await resendOtp({ pending: pending(), fetchImpl });
    expect(result.kind).toBe("needs_otp");
    if (result.kind !== "needs_otp") throw new Error("expected needs_otp");
    expect(result.pending.username).toBe("buyer@example.com");
    expect(result.pending).not.toHaveProperty("password");
  });
});
