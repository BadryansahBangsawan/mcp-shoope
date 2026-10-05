import { describe, expect, it } from "vitest";
import { DEFAULT_CODEMODE_LIMITS, type CodemodeLimits } from "../../src/codemode/budget";
import { NO_VALUE_MESSAGE } from "../../src/codemode/output";
import { runCodemode, sandboxProgram } from "../../src/codemode/run";
import { createSpecBundle } from "../../src/codemode/spec";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import {
  abortableDelay,
  createFakeDispatcher,
  type FakeDispatcher,
  type FixtureHandler,
} from "../stubs/codemode-harness";
import { createFakeWorkerLoader } from "../stubs/fake-worker-loader";

const spec = createSpecBundle();
const LIST = "codemode.request({ operationId: 'account.profile' })";

function run(code: string, dispatcher: FakeDispatcher, limits?: Partial<CodemodeLimits>, mode: "execute" | "search" = "execute") {
  return runCodemode({ loader: createFakeWorkerLoader(), code, mode, spec, dispatcher, limits });
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

const profileFixture = (handler: FixtureHandler) => createFakeDispatcher({ "account.profile": handler });

describe("per-execution request budget", () => {
  it("defaults match the documented limits", () => {
    expect(DEFAULT_CODEMODE_LIMITS).toMatchObject({
      timeoutMs: 30_000,
      maxRequests: 50,
      maxConcurrency: 4,
      maxResponseChars: 5_000_000,
    });
  });

  it("stops a 300-call fan-out at 50 requests with RESULT_LIMIT_EXCEEDED", async () => {
    const dispatcher = profileFixture(() => ({ ok: true }));
    const err = await rejection(
      run(`async () => (await Promise.all(Array.from({ length: 300 }, () => ${LIST}))).length`, dispatcher),
    );
    expect(err.code).toBe(ErrorCodes.RESULT_LIMIT_EXCEEDED);
    expect(err.message).toMatch(/at most 50/);
    expect(dispatcher.calls.length).toBeLessThanOrEqual(50);
  });

  it("is terminal: catching the limit error does not let the script continue", async () => {
    const dispatcher = profileFixture(() => ({ ok: true }));
    const code = `async () => {
      let ok = 0;
      for (let i = 0; i < 5; i++) { try { await ${LIST}; ok++; } catch (e) { return { ok, swallowed: e.message }; } }
      return { ok };
    }`;
    const err = await rejection(run(code, dispatcher, { maxRequests: 3 }));
    expect(err.code).toBe(ErrorCodes.RESULT_LIMIT_EXCEEDED);
    expect(dispatcher.calls).toHaveLength(3);
  });

  it("allows at most 4 upstream requests in flight and queues the rest", async () => {
    const dispatcher = profileFixture((_req, opts) => abortableDelay(10, opts?.signal).then(() => ({ ok: true })));
    const out = await run(`async () => (await Promise.all(Array.from({ length: 20 }, () => ${LIST}))).length`, dispatcher);
    expect(out).toBe("20");
    expect(dispatcher.calls).toHaveLength(20);
    expect(dispatcher.peakInFlight).toBe(4);
  });

  it("enforces the cumulative response budget", async () => {
    const dispatcher = profileFixture(() => ({ blob: "x".repeat(4_000) }));
    const code = `async () => { const out = []; for (let i = 0; i < 10; i++) out.push(await ${LIST}); return out.length; }`;
    const err = await rejection(run(code, dispatcher, { maxResponseChars: 10_000 }));
    expect(err.code).toBe(ErrorCodes.RESULT_LIMIT_EXCEEDED);
    expect(err.message).toMatch(/Response budget exceeded/);
    expect(dispatcher.calls).toHaveLength(3);
  });

  it("caps codemode.spec() calls", async () => {
    const dispatcher = profileFixture(() => ({}));
    const err = await rejection(
      run("async () => { for (let i = 0; i < 5; i++) await codemode.spec(); return 'done'; }", dispatcher, { maxSpecCalls: 2 }, "search"),
    );
    expect(err.code).toBe(ErrorCodes.RESULT_LIMIT_EXCEEDED);
  });
});

describe("host-side deadline", () => {
  it("cannot be disabled by overriding setTimeout in the sandbox", async () => {
    const dispatcher = profileFixture((_req, opts) => abortableDelay(5, opts?.signal).then(() => ({ ok: true })));
    const code = `async () => {
      globalThis.setTimeout = () => 0;
      while (true) await ${LIST};
    }`;
    const started = Date.now();
    const err = await rejection(run(code, dispatcher, { timeoutMs: 200 }));
    expect(err.code).toBe(ErrorCodes.UPSTREAM_TIMEOUT);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts in-flight dispatches through the signal passed to dispatch()", async () => {
    let seen: AbortSignal | undefined;
    const dispatcher = profileFixture((_req, opts) => {
      seen = opts?.signal;
      return abortableDelay(60_000, opts?.signal);
    });
    const err = await rejection(run(`async () => ${LIST}`, dispatcher, { timeoutMs: 150 }));
    expect(err.code).toBe(ErrorCodes.UPSTREAM_TIMEOUT);
    expect(seen?.aborted).toBe(true);
  });

  it("refuses request() calls made after the deadline", async () => {
    const dispatcher = profileFixture(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20)));
    const code = `async () => {
      const st = setTimeout;
      globalThis.setTimeout = () => 0;
      const errors = [];
      for (let i = 0; i < 40; i++) {
        try { await ${LIST}; } catch (e) { errors.push(e.message); await new Promise((r) => st(r, 5)); }
      }
      return errors;
    }`;
    const err = await rejection(run(code, dispatcher, { timeoutMs: 120 }));
    expect(err.code).toBe(ErrorCodes.UPSTREAM_TIMEOUT);
    const callsAtDeadline = dispatcher.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(dispatcher.calls.length).toBe(callsAtDeadline);
  });

  it("cancels fire-and-forget requests once the script returns", async () => {
    let seen: AbortSignal | undefined;
    const dispatcher = profileFixture((_req, opts) => {
      seen = opts?.signal;
      return abortableDelay(60_000, opts?.signal);
    });
    const out = await run(`async () => { ${LIST}.catch(() => {}); await new Promise((r) => setTimeout(r, 20)); return 'returned'; }`, dispatcher);
    expect(out).toBe("returned");
    expect(seen?.aborted).toBe(true);
  });
});

describe("tool output", () => {
  const noCalls = () => profileFixture(() => ({}));
  const cap = DEFAULT_CODEMODE_LIMITS.maxOutputTokens * 4 + 300;

  it("never pretty-prints: deeply nested results stay within the cap", async () => {
    const out = await run("async () => { let v = 1; for (let i = 0; i < 1500; i++) v = [v]; return v; }", noCalls());
    // Pretty-printing this value would be ~2.25M characters; compact JSON is ~3k.
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).not.toContain("\n  ");
  });

  it("reports a result too deeply nested to transfer as INVALID_INPUT", async () => {
    const err = await rejection(run("async () => { let v = 1; for (let i = 0; i < 20000; i++) v = [v]; return v; }", noCalls()));
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toMatch(/too deeply nested|not JSON-serializable/);
  });

  it("hard-caps long strings and large arrays", async () => {
    const str = await run("async () => 'x'.repeat(200000)", noCalls());
    expect(str.length).toBeLessThanOrEqual(cap);
    expect(str).toContain("TRUNCATED");
    const arr = await run("async () => Array.from({ length: 20000 }, (_, i) => ({ i, name: 'item ' + i }))", noCalls());
    expect(arr.length).toBeLessThanOrEqual(cap);
    expect(() => JSON.parse(arr)).not.toThrow();
  });

  it("explains an undefined result instead of emitting an empty text block", async () => {
    await expect(run("async () => { await codemode.spec(); }", noCalls(), undefined, "search")).resolves.toBe(NO_VALUE_MESSAGE);
  });

  it("rejects results that cannot be serialized", async () => {
    const err = await rejection(run("async () => ({ n: 10n })", noCalls()));
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(err.message).toMatch(/not JSON-serializable/);
  });
});

describe("sandbox program wrapper (final review code-1/4/5)", () => {
  it("tolerates a trailing semicolon and a code fence", () => {
    const program = sandboxProgram("```js\nasync () => { return 1; };\n```", 1000);
    expect(program).toContain("await (async () => { return 1; })()");
  });

  it("gives thrown non-Errors a message and caps the serialized result inside the sandbox", async () => {
    const run = (code: string) =>
      (new Function(`return (${sandboxProgram(code, 50)})`)() as () => Promise<unknown>)();
    await expect(run("async () => { throw 'shop not found'; }")).rejects.toThrow("Script threw: shop not found");
    await expect(run("async () => { throw new Error(''); }")).rejects.toThrow("Script threw:");
    await expect(run("async () => 'x'.repeat(100)")).rejects.toThrow(/^RESULT_TOO_LARGE \d+$/);
    await expect(run("async () => ({ a: 1 })")).resolves.toEqual({ __json: '{"a":1}' });
    await expect(run("async () => { await 1; }")).resolves.toBeUndefined();
  });
});
