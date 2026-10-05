import { AuthorizationError, type AuthRequest, type CompleteAuthorizationOptions, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { issueOwnerCookie } from "../../src/auth/owner";
import { handleAuthorize, handleLogin, safeNext, type OwnerRoutesEnv } from "../../src/auth/owner-routes";

const BASE = "https://mcp.shopee.badry.engineer";
const PASSWORD = "correct-horse-battery-staple";
const RATE_LIMIT_COPY = "Terlalu banyak percobaan gagal dari jaringan ini. Tunggu 15 menit lalu coba lagi.";

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: ["shopee:read"],
  state: "state-1",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: `${BASE}/mcp`,
  issuer: BASE,
};

function makeEnv(overrides: Partial<OwnerRoutesEnv> = {}) {
  const completed: CompleteAuthorizationOptions[] = [];
  let attempts = 0;
  const provider = {
    parseAuthRequest: vi.fn(async () => AUTH_REQUEST),
    lookupClient: vi.fn(async () => ({
      clientId: "client-1",
      clientName: "Claude",
      redirectUris: [AUTH_REQUEST.redirectUri],
      tokenEndpointAuthMethod: "none",
    })),
    completeAuthorization: vi.fn(async (opts: CompleteAuthorizationOptions) => {
      completed.push(opts);
      return { redirectTo: `${AUTH_REQUEST.redirectUri}?code=abc&state=${AUTH_REQUEST.state}` };
    }),
  } as unknown as OAuthHelpers;
  const rateLimitStub = {
    checkRateLimit: vi.fn(async ({ limit }: { limit?: number }) => {
      attempts++;
      return { ok: attempts <= (limit ?? 10) * 2, retryAfterMs: 0 };
    }),
  };
  const env: OwnerRoutesEnv = {
    OWNER_PASSWORD: PASSWORD,
    SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    OAUTH_PROVIDER: provider,
    SHOPEE_SESSIONS: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => rateLimitStub,
    } as unknown as DurableObjectNamespace,
    ENABLE_MUTATIONS: "false",
    ...overrides,
  };
  return { env, provider, completed, rateLimitStub };
}

const AUTHORIZE_URL = `${BASE}/authorize?response_type=code&client_id=client-1&state=state-1`;

function cookieOf(res: Response, name: string): string {
  const c = res.headers.getSetCookie().find((v) => v.startsWith(name));
  return c ? c.split(";")[0]! : "";
}

async function openConsent(env: OwnerRoutesEnv) {
  const res = await handleAuthorize(new Request(AUTHORIZE_URL), env);
  const html = await res.text();
  const csrf = /name="csrf" value="([a-f0-9]{32})"/.exec(html)?.[1] ?? "";
  return { res, html, csrf, cookie: cookieOf(res, "__Host-sp_csrf") };
}

function postConsent(env: OwnerRoutesEnv, cookie: string, body: Record<string, string | string[]>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const item of [v].flat()) form.append(k, item);
  return handleAuthorize(
    new Request(AUTHORIZE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: form,
    }),
    env,
  );
}

describe("/authorize consent", () => {
  it("fails closed when owner auth is not configured", async () => {
    const { env } = makeEnv({ OWNER_PASSWORD: undefined });
    const res = await handleAuthorize(new Request(AUTHORIZE_URL), env);
    expect(res.status).toBe(503);
  });

  it("renders a consent page with client details, CSRF and anti-framing headers", async () => {
    const { env } = makeEnv();
    const { res, html, csrf, cookie } = await openConsent(env);
    expect(res.status).toBe(200);
    expect(csrf).toHaveLength(32);
    expect(cookie).toContain("__Host-sp_csrf=");
    expect(html).toContain("https://claude.ai");
    expect(html).toContain('name="password"');
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not offer shopee:write when mutations are disabled and not requested", async () => {
    const { env } = makeEnv();
    const { html } = await openConsent(env);
    expect(html).toContain('value="shopee:read"');
    expect(html).not.toContain('value="shopee:write"');
  });

  it("rejects a missing or mismatched CSRF token without granting", async () => {
    const { env, completed } = makeEnv();
    const { cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, { csrf: "0".repeat(32), decision: "approve", scope: "shopee:read", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(completed).toHaveLength(0);
  });

  it("rejects a wrong owner password without granting", async () => {
    const { env, completed } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, { csrf, decision: "approve", scope: "shopee:read", password: "wrong-password-value" });
    expect(res.status).toBe(401);
    expect(completed).toHaveLength(0);
  });

  it("redirects with access_denied, state and iss when the owner denies", async () => {
    const { env, completed } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, { csrf, decision: "deny" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(completed).toHaveLength(0);
  });

  it("grants only offered scopes and binds props to the owner", async () => {
    const { env, completed } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, {
      csrf,
      decision: "approve",
      scope: ["shopee:read", "shopee:admin", "shopee:write"],
      password: PASSWORD,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=abc");
    expect(cookieOf(res, "__Host-sp_owner")).toContain("__Host-sp_owner=");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.userId).toBe("owner");
    expect(completed[0]!.scope).toEqual(["shopee:read"]);
    expect(completed[0]!.props).toMatchObject({ subject: "owner", scopes: ["shopee:read"], clientId: "client-1" });
  });

  it("requires at least one scope", async () => {
    const { env, completed } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, { csrf, decision: "approve", password: PASSWORD });
    expect(res.status).toBe(400);
    expect(completed).toHaveLength(0);
  });

  it("skips the password for a signed-in owner but still requires explicit approval", async () => {
    const { env, completed } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    const owner = (await issueOwnerCookie(new Request(BASE), env)).split(";")[0]!;
    const res = await postConsent(env, `${cookie}; ${owner}`, { csrf, decision: "approve", scope: "shopee:read" });
    expect(res.status).toBe(302);
    expect(completed).toHaveLength(1);
  });

  it("renders invalid requests locally even when the redirect URI validated (no open redirect)", async () => {
    const { env, provider } = makeEnv();
    vi.mocked(provider.parseAuthRequest).mockRejectedValueOnce(
      new AuthorizationError("invalid_request", {
        description: "Bad scope",
        redirectUri: "https://evil.example/fake-login",
        state: "s",
      }),
    );
    const res = await handleAuthorize(new Request(AUTHORIZE_URL), env);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("counts only failed password attempts and never blocks on another network's failures", async () => {
    const { env, rateLimitStub } = makeEnv();
    const { csrf, cookie } = await openConsent(env);
    await postConsent(env, cookie, { csrf, decision: "approve", scope: "shopee:read", password: "wrong-password-value" });
    const calls = rateLimitStub.checkRateLimit.mock.calls.map(([input]) => input as { key: string; peek?: boolean });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ peek: true });
    expect(calls[1]!.peek).toBeUndefined();
    expect(calls.every((c) => c.key.startsWith("fail:"))).toBe(true);
    rateLimitStub.checkRateLimit.mockClear();
    const ok = await postConsent(env, cookie, { csrf, decision: "approve", scope: "shopee:read", password: PASSWORD });
    expect(ok.status).toBe(302);
    expect(rateLimitStub.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("renders invalid requests locally when the redirect URI is not validated", async () => {
    const { env, provider } = makeEnv();
    vi.mocked(provider.parseAuthRequest).mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "Invalid redirect URI" }),
    );
    const res = await handleAuthorize(new Request(AUTHORIZE_URL), env);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("stops password attempts once rate limited", async () => {
    const { env, rateLimitStub } = makeEnv();
    rateLimitStub.checkRateLimit.mockResolvedValue({ ok: false, retryAfterMs: 1000 });
    const { csrf, cookie } = await openConsent(env);
    const res = await postConsent(env, cookie, { csrf, decision: "approve", scope: "shopee:read", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(RATE_LIMIT_COPY);
  });
});

describe("safeNext", () => {
  it.each([
    ["/%09/evil.example", "/connect"],
    ["/\t/evil.example", "/connect"],
    ["//evil.example", "/connect"],
    ["/\\evil.example", "/connect"],
    ["https://evil.example/", "/connect"],
    ["/admin", "/connect"],
    ["/connect", "/connect"],
    ["/connect/status", "/connect/status"],
    ["/approvals/123e4567-e89b-42d3-a456-426614174000", "/approvals/123e4567-e89b-42d3-a456-426614174000"],
  ])("safeNext(%j) → %j", (input, expected) => {
    expect(safeNext(decodeURIComponent(input))).toBe(expected);
  });
});

describe("/login", () => {
  it("only redirects to same-origin relative paths after sign-in", async () => {
    const { env } = makeEnv();
    const page = await handleLogin(new Request(`${BASE}/login?next=//evil.example/x`), env);
    const html = await page.text();
    expect(html).toContain('name="next" value="/connect"');
    const csrf = /name="csrf" value="([a-f0-9]{32})"/.exec(html)![1]!;
    const res = await handleLogin(
      new Request(`${BASE}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieOf(page, "__Host-sp_csrf") },
        body: new URLSearchParams({ csrf, next: "https://evil.example/", password: PASSWORD }),
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/connect");
    expect(cookieOf(res, "__Host-sp_owner")).not.toBe("");
  });
});
