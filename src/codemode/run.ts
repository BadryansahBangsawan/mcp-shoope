import { DynamicWorkerExecutor, normalizeCode, type ExecuteResult } from "@cloudflare/codemode";
import type { DispatchRequest, DispatchResult } from "../dispatcher/shopee-dispatcher";
import { AppError, ErrorCodes } from "../errors/codes";
import { getOperation } from "../registry/operations";
import { DEFAULT_CODEMODE_LIMITS, ExecutionBudget, type CodemodeLimits } from "./budget";
import { executorFailure, SandboxErrorBridge, timeoutError } from "./errors";
import { formatResult } from "./output";
import type { CodemodeSpecBundle } from "./spec";

/** The dispatcher surface Code Mode needs (contract C2). */
export interface CodemodeDispatcher {
  dispatch(
    req: DispatchRequest,
    opts?: { allowMutation?: boolean; signal?: AbortSignal },
  ): Promise<DispatchResult>;
  /** Local checks only (validation, session, URL, headers); no upstream request. */
  preflight?(req: DispatchRequest, opts?: { allowMutation?: boolean }): Promise<void>;
}

export interface RunCodeOptions {
  loader: WorkerLoader;
  code: string;
  /** search: codemode.spec() only. execute: + read-only codemode.request(). */
  mode: "search" | "execute";
  spec: CodemodeSpecBundle;
  dispatcher?: CodemodeDispatcher;
  limits?: Partial<CodemodeLimits>;
  /** Whether execute_mutation is registered for this caller (shapes the write-refusal hint). */
  mutationToolAvailable?: boolean;
}

type HostFn = (...args: unknown[]) => Promise<unknown>;

const REQUEST_KEYS = new Set(["operationId", "path", "query", "body"]);

/**
 * Run model JavaScript in an isolated dynamic Worker (globalOutbound: null, no
 * bindings). Host functions are the only way out, and all limits live here on
 * the host: deadline, request count, concurrency, response budget, output cap.
 * Resolves to the final, size-capped tool text.
 */
export async function runCodemode(options: RunCodeOptions): Promise<string> {
  const limits: CodemodeLimits = { ...DEFAULT_CODEMODE_LIMITS, ...options.limits };
  if (options.mode === "execute" && !options.dispatcher) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Dispatcher required for execute");
  }
  const budget = new ExecutionBudget(limits);
  const bridge = new SandboxErrorBridge();
  const fns = hostFunctions(options, budget, bridge);

  const executor = new DynamicWorkerExecutor({
    loader: withCpuLimit(options.loader, limits.cpuMs),
    timeout: limits.timeoutMs,
    globalOutbound: null,
  });

  const stopped = new Promise<never>((_, reject) => {
    budget.signal.addEventListener("abort", () => reject(budget.signal.reason), { once: true });
  });
  const timer = setTimeout(() => budget.abort(timeoutError(limits.timeoutMs)), limits.timeoutMs);
  const run = executor.execute(sandboxProgram(options.code, limits.maxSandboxResultChars), [{ name: "codemode", fns }]);
  run.catch(() => undefined);

  let result: ExecuteResult;
  try {
    result = await Promise.race([run, stopped]);
  } catch (err) {
    throw executorFailure(err);
  } finally {
    clearTimeout(timer);
    budget.abort(new AppError(ErrorCodes.INVALID_INPUT, "Code Mode execution has already finished"));
  }
  if (result.error !== undefined) throw bridge.fromSandbox(String(result.error), limits.timeoutMs);
  return formatResult(decodeSandboxResult(result.result), limits.maxOutputTokens);
}

const RESULT_TOO_LARGE = "RESULT_TOO_LARGE";

export function sandboxProgram(code: string, maxResultChars: number): string {
  const source = normalizeCode(
    code.trim().replace(/^```[a-z]*\s*\n([\s\S]*?)```\s*$/i, "$1").trim().replace(/;+\s*$/, ""),
  );
  return `async () => {
  let value;
  try {
    value = await (${source})();
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : (() => { try { return "Script threw: " + String(e); } catch { return "Script threw a " + typeof e; } })();
    throw new Error(msg);
  }
  if (value === undefined) return undefined;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    throw new Error("Result is not JSON-serializable: " + (e instanceof Error ? e.message : String(e)));
  }
  if (text === undefined) return undefined;
  if (text.length > ${maxResultChars}) throw new Error("${RESULT_TOO_LARGE} " + text.length);
  return { __json: text };
}`;
}

function decodeSandboxResult(value: unknown): unknown {
  if (value && typeof value === "object" && typeof (value as { __json?: unknown }).__json === "string") {
    return JSON.parse((value as { __json: string }).__json);
  }
  return value;
}

function hostFunctions(
  options: RunCodeOptions,
  budget: ExecutionBudget,
  bridge: SandboxErrorBridge,
): Record<string, HostFn> {
  const fns: Record<string, HostFn> = {
    spec: async () => {
      try {
        budget.countSpecCall();
        return options.spec;
      } catch (err) {
        throw bridge.toSandbox(err);
      }
    },
  };
  const dispatcher = options.dispatcher;
  if (options.mode !== "execute" || !dispatcher) return fns;

  fns.request = async (raw: unknown) => {
    let release: (() => void) | undefined;
    try {
      budget.countRequest();
      const req = normalizeRequestArgs(raw);
      assertReadOperation(req.operationId, options.mutationToolAvailable === true);
      release = await budget.acquireSlot();
      const result = await dispatcher.dispatch(req, { signal: budget.signal });
      budget.assertActive();
      budget.chargeResponse(result);
      return result;
    } catch (err) {
      throw bridge.toSandbox(err);
    } finally {
      release?.();
    }
  };
  return fns;
}

function assertReadOperation(operationId: string, mutationToolAvailable: boolean): void {
  const op = getOperation(operationId);
  if (!op || !op.exposed) {
    throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `Unknown operationId ${operationId}`);
  }
  if (op.safety !== "read") {
    throw new AppError(
      ErrorCodes.MUTATION_DISABLED,
      mutationToolAvailable
        ? `${operationId} is a ${op.safety} operation; execute is read-only. Use the execute_mutation tool, which requires owner approval`
        : `${operationId} is a ${op.safety} operation; execute is read-only and writes are disabled on this server`,
    );
  }
}

function withCpuLimit(loader: WorkerLoader, cpuMs: number): WorkerLoader {
  return {
    load: (code) => loader.load({ ...code, limits: { ...code.limits, cpuMs } }),
    get: (name, getCode) =>
      loader.get(name, async () => {
        const code = await getCode();
        return { ...code, limits: { ...code.limits, cpuMs } };
      }),
  };
}

function normalizeRequestArgs(raw: unknown): DispatchRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "request() expects an object { operationId, path, query, body }");
  }
  const o = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(o).filter((k) => !REQUEST_KEYS.has(k));
  if (unknownKeys.length) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      `request() rejects ${unknownKeys.join(", ")}: method, url, headers and credentials are fixed by the operationId`,
    );
  }
  if (typeof o.operationId !== "string" || !o.operationId) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "operationId is required");
  }
  const req: DispatchRequest = { operationId: o.operationId };
  const path = primitiveMap(o.path, "path", false);
  const query = primitiveMap(o.query, "query", true);
  if (path) req.path = path as Record<string, string | number>;
  if (query) req.query = query;
  if (o.body !== undefined) req.body = o.body;
  return req;
}

function primitiveMap(
  value: unknown,
  label: string,
  allowBoolean: boolean,
): Record<string, string | number | boolean> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, `${label} must be an object`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const ok = typeof v === "string" || typeof v === "number" || (allowBoolean && typeof v === "boolean");
    if (!ok) {
      throw new AppError(
        ErrorCodes.INVALID_INPUT,
        `${label}.${k} must be a string${allowBoolean ? ", number or boolean" : " or number"}`,
      );
    }
    out[k] = v;
  }
  return out;
}
