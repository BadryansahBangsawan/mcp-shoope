import vm from "node:vm";

/**
 * Test double for the Worker Loader binding. It runs the executor module that
 * DynamicWorkerExecutor generates inside a separate `node:vm` context, which
 * approximates the dynamic-Worker isolate closely enough for host-side tests:
 * - own globals (model code overriding setTimeout cannot touch the host timers)
 * - fetch()/connect() throw when globalOutbound is null, as workerd does
 * - the evaluate() response is structured-cloned, like a Workers RPC return
 * It cannot emulate CPU limits or preempt a synchronous infinite loop.
 */
export interface FakeWorkerLoader extends WorkerLoader {
  /** Every WorkerLoaderWorkerCode passed to load(), for assertions. */
  readonly loads: WorkerLoaderWorkerCode[];
}

interface EvaluateResponse {
  result?: unknown;
  error?: string;
  logs?: string[];
}

interface CodeExecutorInstance {
  evaluate(dispatchers: unknown, connectors: unknown): Promise<EvaluateResponse>;
}

type CodeExecutorClass = new (ctx: unknown, env: unknown) => CodeExecutorInstance;

const IMPORT_LINE = 'import { WorkerEntrypoint } from "cloudflare:workers";';
const EXPORT_DECL = "export default class CodeExecutor";
const BLOCKED_OUTBOUND =
  "This worker is not permitted to access the internet via global functions like fetch().";

const SANDBOX_PRELUDE = `
class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
globalThis.WorkerEntrypoint = WorkerEntrypoint;
`;

function moduleSource(code: WorkerLoaderWorkerCode): string {
  const main = code.modules[code.mainModule];
  if (typeof main !== "string") throw new Error("fake loader: main module must be a JS string");
  if (!main.includes(IMPORT_LINE) || !main.includes(EXPORT_DECL)) {
    throw new Error("fake loader: unexpected executor module shape");
  }
  return main
    .replace(IMPORT_LINE, "")
    .replace(EXPORT_DECL, "globalThis.__CodeExecutor = class CodeExecutor");
}

function createSandboxContext(code: WorkerLoaderWorkerCode): vm.Context {
  const blocked = () => {
    throw new Error(BLOCKED_OUTBOUND);
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn: () => void, ms?: number) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    atob,
    btoa,
    fetch: code.globalOutbound === null ? blocked : undefined,
    connect: code.globalOutbound === null ? blocked : undefined,
  });
  vm.runInContext(SANDBOX_PRELUDE, context);
  vm.runInContext(moduleSource(code), context);
  return context;
}

export function createFakeWorkerLoader(): FakeWorkerLoader {
  const loads: WorkerLoaderWorkerCode[] = [];
  const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
    loads.push(code);
    if (code.globalOutbound !== null) {
      throw new Error("fake loader: sandbox must be created with globalOutbound: null");
    }
    const context = createSandboxContext(code);
    const entrypoint = {
      async evaluate(dispatchers: unknown, connectors: unknown): Promise<EvaluateResponse> {
        const Executor = context.__CodeExecutor as CodeExecutorClass;
        const response = await new Executor({}, code.env ?? {}).evaluate(dispatchers, connectors);
        return structuredClone(response);
      },
    };
    const stub = {
      getEntrypoint: () => entrypoint,
      getDurableObjectClass: () => {
        throw new Error("fake loader: durable object classes are not supported");
      },
    };
    // The executor only calls getEntrypoint().evaluate(); the stub is not a full Fetcher.
    return stub as unknown as WorkerStub;
  };
  return {
    loads,
    load,
    get: () => {
      throw new Error("fake loader: DynamicWorkerExecutor only uses load()");
    },
  };
}
