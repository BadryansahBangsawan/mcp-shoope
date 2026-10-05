import { describe, expect, it, vi } from "vitest";
import { runCodemode } from "../../src/codemode/run";
import { createSpecBundle } from "../../src/codemode/spec";
import { ShopeeDispatcher } from "../../src/dispatcher/shopee-dispatcher";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import type { ShopeeSessionContext, ShopeeSessionProvider } from "../../src/session/types";
import { createFakeWorkerLoader } from "../stubs/fake-worker-loader";

/** End-to-end through the real ShopeeDispatcher with a mocked fetch (no network). */
const COOKIE_EC = "SPC-EC-must-never-reach-the-sandbox-0000";
const CSRF = "csrf-must-never-reach-the-sandbox";

function session(extra: Partial<ShopeeSessionContext> = {}): ShopeeSessionContext {
  return {
    cookies: [
      { name: "SPC_EC", value: COOKIE_EC, domain: "shopee.co.id", hostOnly: true, path: "/" },
      { name: "csrftoken", value: CSRF, domain: "shopee.co.id", hostOnly: true, path: "/" },
    ],
    csrfToken: CSRF,
    connectedAt: 1_700_000_000_000,
    subject: "owner",
    source: "login",
    fingerprint: "a".repeat(64),
    ...extra,
  };
}

function sessions(current: ShopeeSessionContext = session()): ShopeeSessionProvider {
  return {
    getSession: vi.fn(async () => current),
    markExpired: vi.fn(),
  };
}

function dispatcher(fetchImpl: typeof fetch | ReturnType<typeof vi.fn>, provider: ShopeeSessionProvider = sessions()) {
  return new ShopeeDispatcher({
    sessions: provider,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const spec = createSpecBundle();

function execute(code: string, d: ShopeeDispatcher, limits?: { timeoutMs: number }) {
  return runCodemode({
    loader: createFakeWorkerLoader(),
    mode: "execute",
    spec,
    dispatcher: d,
    limits,
    code,
  });
}

describe("Code Mode with the real dispatcher", () => {
  it("serves reads while cookie/CSRF stay on the host", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const resolved = new URL(String(url));
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(resolved.protocol).toBe("https:");
      expect(resolved.hostname).toBe("shopee.co.id");
      expect(resolved.pathname).toBe("/api/v4/account/profile");
      expect(resolved.searchParams.get("partner_id")).toBeNull();
      expect(resolved.searchParams.get("access_token")).toBeNull();
      expect(resolved.searchParams.get("shop_id")).toBeNull();
      expect(resolved.searchParams.get("sign")).toBeNull();
      expect(resolved.searchParams.get("timestamp")).toBeNull();
      expect(headers.get("cookie")).toBe(`SPC_EC=${COOKIE_EC}; csrftoken=${CSRF}`);
      expect(headers.get("x-csrftoken")).toBe(CSRF);
      expect(headers.get("origin")).toBe("https://shopee.co.id");
      expect(headers.get("referer")).toBe("https://shopee.co.id/");
      return Response.json({ error: "", data: { username: "buyer" } });
    });
    const out = await execute(
      `async () => {
        const r = await codemode.request({ operationId: 'account.profile' });
        return { r, globals: Object.getOwnPropertyNames(globalThis), self: JSON.stringify(this ?? null) };
      }`,
      dispatcher(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out).toContain("buyer");
    for (const secret of [COOKIE_EC, CSRF]) expect(out).not.toContain(secret);
  });

  it("the host deadline aborts the upstream fetch", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
        }),
    );
    const err = await execute(
      "async () => codemode.request({ operationId: 'account.profile' })",
      dispatcher(fetchImpl),
      { timeoutMs: 150 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCodes.UPSTREAM_TIMEOUT);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("401 expires the jar once without refresh", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "error_auth", message: "invalid_token" }, { status: 401 }),
    );
    const provider = sessions();
    const err = await execute(
      "async () => codemode.request({ operationId: 'account.profile' })",
      dispatcher(fetchImpl, provider),
    ).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(ErrorCodes.SHOPEE_AUTH_EXPIRED);
    expect(provider.markExpired).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveProperty("refresh");
  });
});
