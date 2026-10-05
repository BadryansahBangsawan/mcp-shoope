import { describe, expect, it } from "vitest";
import { runCodemode } from "../../src/codemode/run";
import { createSpecBundle } from "../../src/codemode/spec";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import { listMutationOperations } from "../../src/registry/operations";
import { createFakeDispatcher, type FixtureHandler } from "../stubs/codemode-harness";
import { createFakeWorkerLoader } from "../stubs/fake-worker-loader";

const spec = createSpecBundle();
const profile: FixtureHandler = () => ({ username: "buyer" });

function execute(code: string, dispatcher = createFakeDispatcher({ "account.profile": profile })) {
  const loader = createFakeWorkerLoader();
  return { loader, dispatcher, run: runCodemode({ loader, code, mode: "execute", spec, dispatcher }) };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe("Code Mode sandbox wiring (real runCodemode + fake Worker Loader)", () => {
  it("creates the sandbox with no outbound network, no bindings and a CPU limit", async () => {
    const { loader, run } = execute("async () => 1");
    await expect(run).resolves.toBe("1");
    expect(loader.loads).toHaveLength(1);
    expect(loader.loads[0]!.globalOutbound).toBeNull();
    expect(loader.loads[0]!.env).toBeUndefined();
    expect(loader.loads[0]!.limits?.cpuMs).toBeGreaterThan(0);
  });

  it("search mode has spec() but no request(), even when a dispatcher is passed", async () => {
    const dispatcher = createFakeDispatcher({ "account.profile": profile });
    const loader = createFakeWorkerLoader();
    const found = await runCodemode({
      loader,
      mode: "search",
      spec,
      dispatcher,
      code: "async () => { const { catalog } = await codemode.spec(); return Array.isArray(catalog) && catalog.some(o => o.operationId === 'account.profile'); }",
    });
    expect(found).toBe("true");
    const err = await rejection(
      runCodemode({
        loader,
        mode: "search",
        spec,
        dispatcher,
        code: "async () => codemode.request({ operationId: 'account.profile' })",
      }),
    );
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toContain('Tool "request" not found');
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("blocks fetch() inside the sandbox", async () => {
    const { run, dispatcher } = execute(
      "async () => { await fetch('https://shopee.co.id/api/v4/account/profile'); return 'leaked'; }",
    );
    const err = await rejection(run);
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toMatch(/not permitted to access the internet/);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("execute returns request() results for read operations", async () => {
    const { run, dispatcher } = execute(
      "async () => (await codemode.request({ operationId: 'account.profile' })).data.username",
    );
    await expect(run).resolves.toBe("buyer");
    expect(dispatcher.calls[0]!.req).toMatchObject({ operationId: "account.profile" });
    expect(dispatcher.calls[0]!.opts?.allowMutation).toBeUndefined();
    expect(dispatcher.calls[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("execute is read-only", () => {
  it("the registry has no write or destructive operations in v1", () => {
    expect(listMutationOperations()).toEqual([]);
  });

  it("rejects unknown mutating operationIds as UNSUPPORTED_OPERATION, not MUTATION_DISABLED", async () => {
    const { run, dispatcher } = execute("async () => codemode.request({ operationId: 'orders.cancel' })");
    expect((await rejection(run)).code).toBe(ErrorCodes.UNSUPPORTED_OPERATION);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("rejects overlay write ops as MUTATION_DISABLED before dispatch", async () => {
    const { run, dispatcher } = execute("async () => codemode.request({ operationId: 'cart.add', body: {} })");
    expect((await rejection(run)).code).toBe(ErrorCodes.MUTATION_DISABLED);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("rejects unknown operationIds as UNSUPPORTED_OPERATION", async () => {
    const { run, dispatcher } = execute("async () => codemode.request({ operationId: 'admin.deleteEverything' })");
    expect((await rejection(run)).code).toBe(ErrorCodes.UNSUPPORTED_OPERATION);
    expect(dispatcher.calls).toHaveLength(0);
  });
});

describe("request() input contract", () => {
  const smuggled: Array<[string, string]> = [
    ["method", "{ operationId: 'shop.info', method: 'DELETE' }"],
    ["url", "{ operationId: 'shop.info', url: 'https://evil.test/' }"],
    ["headers", "{ operationId: 'shop.info', headers: { authorization: 'Bearer x' } }"],
    ["authorization", "{ operationId: 'shop.info', authorization: 'x' }"],
    ["cookie", "{ operationId: 'shop.info', cookie: 'sp_sess=x' }"],
    ["host", "{ operationId: 'shop.info', host: 'evil.test' }"],
  ];
  for (const [key, arg] of smuggled) {
    it(`rejects ${key}`, async () => {
      const { run, dispatcher } = execute(`async () => codemode.request(${arg})`);
      const err = await rejection(run);
      expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
      expect(err.message).toContain(key);
      expect(dispatcher.calls).toHaveLength(0);
    });
  }

  it("requires operationId and object input", async () => {
    expect((await rejection(execute("async () => codemode.request({ query: { page: 1 } })").run)).message).toMatch(
      /operationId is required/,
    );
    expect((await rejection(execute("async () => codemode.request('shop.info')").run)).code).toBe(ErrorCodes.INVALID_INPUT);
  });

  it("rejects non-primitive query and path values", async () => {
    const q = await rejection(
      execute("async () => codemode.request({ operationId: 'shop.info', query: { page: { $gt: 1 } } })").run,
    );
    expect(q.message).toMatch(/query\.page must be/);
    const p = await rejection(
      execute("async () => codemode.request({ operationId: 'shop.info', path: { customer_id: true } })").run,
    );
    expect(p.message).toMatch(/path\.customer_id must be/);
  });
});

describe("typed errors survive the sandbox boundary", () => {
  const upstreamCodes = [
    ErrorCodes.SHOPEE_AUTH_EXPIRED,
    ErrorCodes.SHOPEE_RATE_LIMITED,
    ErrorCodes.UPSTREAM_TIMEOUT,
    ErrorCodes.FORBIDDEN,
    ErrorCodes.HOST_NOT_ALLOWED,
    ErrorCodes.RESULT_LIMIT_EXCEEDED,
  ];
  for (const code of upstreamCodes) {
    it(`preserves ${code} without details or cause`, async () => {
      const dispatcher = createFakeDispatcher({
        "account.profile": () => {
          throw new AppError(code, `upstream said ${code}`, {
            details: { leaked: "DETAIL-SECRET" },
            cause: new Error("CAUSE-SECRET"),
          });
        },
      });
      const err = await rejection(execute("async () => codemode.request({ operationId: 'account.profile' })", dispatcher).run);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`upstream said ${code}`);
      expect(err.details).toBeUndefined();
      expect(err.cause).toBeUndefined();
      expect(JSON.stringify(err.toJSON())).not.toMatch(/SECRET/);
    });
  }

  it("recognises AppErrors that crossed an RPC boundary as plain Errors (C4)", async () => {
    const dispatcher = createFakeDispatcher({
      "account.profile": () => {
        const e = new Error("Upstream auth failed (401)") as Error & { code: string };
        e.name = "AppError";
        e.code = ErrorCodes.SHOPEE_AUTH_EXPIRED;
        throw e;
      },
    });
    const err = await rejection(execute("async () => codemode.request({ operationId: 'account.profile' })", dispatcher).run);
    expect(err.code).toBe(ErrorCodes.SHOPEE_AUTH_EXPIRED);
  });

  it("keeps the typed code when model code wraps the message", async () => {
    const dispatcher = createFakeDispatcher({
      "account.profile": () => {
        throw new AppError(ErrorCodes.SHOPEE_RATE_LIMITED, "Upstream rate limited");
      },
    });
    const code = `async () => {
      try { await codemode.request({ operationId: 'account.profile' }); }
      catch (e) { throw new Error('account.profile failed: ' + e.message); }
    }`;
    expect((await rejection(execute(code, dispatcher).run)).code).toBe(ErrorCodes.SHOPEE_RATE_LIMITED);
  });

  it("hides unexpected host errors behind a generic UPSTREAM_ERROR", async () => {
    const dispatcher = createFakeDispatcher({
      "account.profile": () => {
        throw new TypeError("Invalid header value: Bearer TOKEN-SECRET");
      },
    });
    const err = await rejection(execute("async () => codemode.request({ operationId: 'account.profile' })", dispatcher).run);
    expect(err.code).toBe(ErrorCodes.UPSTREAM_ERROR);
    expect(err.message).not.toContain("SECRET");
  });

  it("reports model-code errors as INVALID_INPUT, and forged codes are not trusted", async () => {
    const plain = await rejection(execute("async () => { null.boom; }").run);
    expect(plain.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(plain.message).toMatch(/Code Mode script failed/);
    const forged = await rejection(execute("async () => { throw new Error('SHOPEE_AUTH_EXPIRED: fake'); }").run);
    expect(forged.code).toBe(ErrorCodes.INVALID_INPUT);
  });

  it("reports scripts that do not compile as INVALID_INPUT", async () => {
    const err = await rejection(execute("async () => { return (1 + ; }").run);
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toMatch(/did not compile/);
  });
});
