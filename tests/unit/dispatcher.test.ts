import { describe, expect, it, vi } from "vitest";
import { HOSTS } from "../../src/dispatcher/allowlist";
import { ShopeeDispatcher, looksLikeLoginHtml } from "../../src/dispatcher/shopee-dispatcher";
import { createRequestSignals, fetchUpstream } from "../../src/dispatcher/upstream";
import { ErrorCodes } from "../../src/errors/codes";
import type { ShopeeSessionContext, ShopeeSessionProvider, StoredCookie } from "../../src/session/types";

function cookie(name: string, value: string): StoredCookie {
  return { name, value, domain: "shopee.co.id", hostOnly: true, path: "/" };
}

function mockSession(extra: Partial<ShopeeSessionContext> = {}): ShopeeSessionContext {
  return {
    cookies: [cookie("SPC_EC", "ec"), cookie("csrftoken", "csrf-value")],
    csrfToken: "csrf-value",
    connectedAt: 1_700_000_000_000,
    subject: "owner",
    source: "login",
    fingerprint: "a".repeat(64),
    ...extra,
  };
}

function sessionsFor(session: ShopeeSessionContext = mockSession()) {
  const markExpired = vi.fn(async (_fp?: string) => undefined);
  const getSession = vi.fn(async () => session);
  const sessions: ShopeeSessionProvider = { getSession, markExpired };
  return { sessions, markExpired, getSession };
}

type FetchArgs = [string | URL | Request, RequestInit?];

function respondWith(make: () => Response) {
  return vi.fn(async (..._args: FetchArgs) => make());
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function dispatcher(
  fetchImpl: ReturnType<typeof vi.fn>,
  opts: { mutationsEnabled?: boolean; session?: ShopeeSessionContext } = {},
) {
  const s = sessionsFor(opts.session ?? mockSession());
  const d = new ShopeeDispatcher({
    sessions: s.sessions,
    mutationsEnabled: opts.mutationsEnabled,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { d, ...s };
}

function sentUrl(fetchImpl: ReturnType<typeof vi.fn>, call = 0): string {
  return String(fetchImpl.mock.calls[call]![0]);
}

function sentInit(fetchImpl: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetchImpl.mock.calls[call]![1] as RequestInit;
}

function sentHeaders(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Headers {
  return new Headers(sentInit(fetchImpl, call).headers);
}

describe("looksLikeLoginHtml", () => {
  it("matches buyer login HTML and rejects JSON", () => {
    expect(looksLikeLoginHtml("<html><a href='/buyer/login'>masuk</a></html>")).toBe(true);
    expect(looksLikeLoginHtml("<html><form>password login</form></html>")).toBe(true);
    expect(looksLikeLoginHtml('{"error":0,"data":{}}')).toBe(false);
    expect(looksLikeLoginHtml("<html>welcome home</html>")).toBe(false);
  });
});

describe("ShopeeDispatcher cookie + CSRF", () => {
  it("rejects unknown operations as UNSUPPORTED_OPERATION, not MUTATION_DISABLED", async () => {
    const fetchImpl = vi.fn();
    const { d } = dispatcher(fetchImpl);
    await expect(d.dispatch({ operationId: "orders.cancel" })).rejects.toMatchObject({
      code: ErrorCodes.UNSUPPORTED_OPERATION,
    });
    await expect(d.dispatch({ operationId: "nope" })).rejects.toMatchObject({
      code: ErrorCodes.UNSUPPORTED_OPERATION,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends Cookie + x-csrftoken to shopee.co.id and never HMAC query or Authorization", async () => {
    const fetchImpl = respondWith(() => json({ error: "", data: { username: "buyer" } }));
    const { d } = dispatcher(fetchImpl);
    const result = await d.dispatch({ operationId: "account.profile" });
    expect(result).toEqual({
      operationId: "account.profile",
      status: 200,
      data: { error: "", data: { username: "buyer" } },
    });

    const url = new URL(sentUrl(fetchImpl));
    expect(url.origin).toBe(`https://${HOSTS.www}`);
    expect(url.pathname).toBe("/api/v4/account/profile");
    expect(url.searchParams.get("partner_id")).toBeNull();
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(url.searchParams.get("shop_id")).toBeNull();
    expect(url.searchParams.get("sign")).toBeNull();
    expect(url.searchParams.get("timestamp")).toBeNull();

    const h = sentHeaders(fetchImpl);
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBe("SPC_EC=ec; csrftoken=csrf-value");
    expect(h.get("x-csrftoken")).toBe("csrf-value");
    expect(h.get("origin")).toBe("https://shopee.co.id");
    expect(h.get("accept")).toBe("application/json");
    expect(sentInit(fetchImpl).method).toBe("GET");
    expect(sentInit(fetchImpl).body).toBeUndefined();
  });

  it("rejects extra reserved keys on closed schemas before they hit the wire", async () => {
    const fetchImpl = vi.fn();
    const { d } = dispatcher(fetchImpl);
    await expect(
      d.dispatch({
        operationId: "account.profile",
        query: { cookie: "evil", authorization: "Bearer x", "x-csrftoken": "stolen" },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    await expect(
      d.dispatch({
        operationId: "cart.get",
        body: { cookie: "evil", csrftoken: "stolen", "set-cookie": "x=1" },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a body on GET account.profile", async () => {
    const fetchImpl = vi.fn();
    const { d } = dispatcher(fetchImpl);
    await expect(
      d.dispatch({ operationId: "account.profile", body: { cookie: "evil" } }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs cart.get JSON with Cookie + CSRF", async () => {
    const fetchImpl = respondWith(() => json({ error: 0, data: { items: [] } }));
    const { d } = dispatcher(fetchImpl);
    const result = await d.dispatch({ operationId: "cart.get", body: {} });
    expect(result.status).toBe(200);
    const url = new URL(sentUrl(fetchImpl));
    expect(url.pathname).toBe("/api/v4/cart/get");
    expect(sentInit(fetchImpl).method).toBe("POST");
    expect(sentInit(fetchImpl).body).toBe("{}");
    expect(sentHeaders(fetchImpl).get("content-type")).toBe("application/json");
    expect(sentHeaders(fetchImpl).get("cookie")).toContain("SPC_EC=ec");
  });

  it("cart.add is MUTATION_DISABLED unless mutations + allowMutation", async () => {
    const fetchImpl = vi.fn();
    const off = dispatcher(fetchImpl, { mutationsEnabled: false });
    await expect(off.d.dispatch({ operationId: "cart.add", body: {} })).rejects.toMatchObject({
      code: ErrorCodes.MUTATION_DISABLED,
    });
    const on = dispatcher(fetchImpl, { mutationsEnabled: true });
    await expect(on.d.dispatch({ operationId: "cart.add", body: {} })).rejects.toMatchObject({
      code: ErrorCodes.MUTATION_DISABLED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValue(json({ error: 0, data: {} }));
    const allowed = dispatcher(fetchImpl, { mutationsEnabled: true });
    await expect(
      allowed.d.dispatch({ operationId: "cart.add", body: {} }, { allowMutation: true }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("ShopeeDispatcher envelope + HTTP errors", () => {
  it("401 expires the jar without a refresh", async () => {
    const fetchImpl = respondWith(() => json({ error: "no" }, 401));
    const { d, markExpired } = dispatcher(fetchImpl);
    await expect(d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(markExpired).toHaveBeenCalledTimes(1);
    expect(markExpired).toHaveBeenCalledWith("a".repeat(64));
  });

  it("error_auth / not_login envelopes expire once", async () => {
    for (const error of ["error_auth", "invalid_token", "not_login", "need_login"]) {
      const fetchImpl = respondWith(() => json({ error, message: "please login" }));
      const { d, markExpired } = dispatcher(fetchImpl);
      await expect(d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
        code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
      });
      expect(markExpired).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("403 JSON is FORBIDDEN and keeps the session; 403 login-HTML expires", async () => {
    const json403 = dispatcher(respondWith(() => json({ error: "forbidden" }, 403)));
    await expect(json403.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
    expect(json403.markExpired).not.toHaveBeenCalled();

    const html403 = dispatcher(
      respondWith(() => html("<html><form action='/buyer/login'>password login</form></html>", 403)),
    );
    await expect(html403.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
    expect(html403.markExpired).toHaveBeenCalledTimes(1);
  });

  it("429 and rate envelopes keep the session", async () => {
    const http = dispatcher(respondWith(() => json({}, 429)));
    await expect(http.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_RATE_LIMITED,
    });
    expect(http.markExpired).not.toHaveBeenCalled();

    const envLimit = dispatcher(respondWith(() => json({ error: "error_limit" })));
    await expect(envLimit.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_RATE_LIMITED,
    });
    expect(envLimit.markExpired).not.toHaveBeenCalled();
  });

  it("error_permission is FORBIDDEN; error_param is UPSTREAM_ERROR; neither expires", async () => {
    const perm = dispatcher(respondWith(() => json({ error: "error_permission", message: "no" })));
    await expect(perm.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
    expect(perm.markExpired).not.toHaveBeenCalled();

    const param = dispatcher(respondWith(() => json({ error: "error_param" })));
    await expect(param.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
    });
    expect(param.markExpired).not.toHaveBeenCalled();
  });

  it("login HTML on 200 expires", async () => {
    const { d, markExpired } = dispatcher(
      respondWith(() => html("<html><a href='/buyer/login'>Masuk</a></html>")),
    );
    await expect(d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
    expect(markExpired).toHaveBeenCalledTimes(1);
  });
});

describe("ShopeeDispatcher redirects", () => {
  it("follows same-host GET 3xx (max 3) that is not a login page", async () => {
    const sameHost = `https://${HOSTS.www}/api/v4/account/profile?followed=1`;
    const follow = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v4/account/profile") && !url.includes("followed=1")) {
        return new Response(null, { status: 302, headers: { location: sameHost } });
      }
      return json({ error: 0, data: { username: "buyer" } });
    });
    const { d, markExpired } = dispatcher(follow);
    const result = await d.dispatch({ operationId: "account.profile" });
    expect(result.status).toBe(200);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(sentUrl(follow, 1)).toBe(sameHost);
    expect(markExpired).not.toHaveBeenCalled();
  });

  it("302 to /buyer/login expires the jar", async () => {
    const login = dispatcher(
      respondWith(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://shopee.co.id/buyer/login" },
          }),
      ),
    );
    await expect(login.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
    expect(login.markExpired).toHaveBeenCalledTimes(1);
  });

  it("refuses POST and cross-host 3xx with REDIRECT_NOT_ALLOWED and does not expire", async () => {
    const cross = dispatcher(
      respondWith(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/steal" },
          }),
      ),
    );
    await expect(cross.d.dispatch({ operationId: "account.profile" })).rejects.toMatchObject({
      code: ErrorCodes.REDIRECT_NOT_ALLOWED,
    });
    expect(cross.markExpired).not.toHaveBeenCalled();

    const start = new URL(`https://${HOSTS.www}/api/v4/cart/get`);
    const postFetch = respondWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: start.toString() },
        }),
    );
    const signals = createRequestSignals(25_000, undefined);
    await expect(
      fetchUpstream(
        start,
        { method: "POST", redirect: "manual" },
        {
          fetchImpl: postFetch as unknown as typeof fetch,
          deadline: signals.deadline,
          signal: signals.signal,
          timeoutMs: 25_000,
          maxRedirects: 3,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.REDIRECT_NOT_ALLOWED });
  });
});
