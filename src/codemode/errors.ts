import { AppError, ErrorCodes, type ErrorCode } from "../errors/codes";
import { log } from "../observability/log";

const KNOWN_CODES = new Set<string>(Object.values(ErrorCodes));
const MAX_SCRIPT_ERROR_CHARS = 1_000;
/** Message DynamicWorkerExecutor's in-sandbox timer rejects with. */
const SANDBOX_TIMEOUT_MESSAGE = "Execution timed out";
const SYNTAX_ERROR = /SyntaxError|Unexpected (token|end of input|identifier|string|number)/;
/** Workers RPC throws this while serializing a pathologically nested return value. */
const STACK_OVERFLOW = /Maximum call stack size exceeded/;
const CLONE_ERROR = /DataCloneError|could not be (serialized|cloned)/i;
const RESOURCE_LIMIT = /exceeded (its )?CPU|CPU time limit|memory limit/i;

/**
 * Recognise an AppError even after it crossed a Durable Object / Workers RPC
 * boundary, where it arrives as a plain Error with name/code copied.
 * Returns a fresh AppError carrying only code + message (never details/cause),
 * unlike errors/codes.ts toAppError, which may return the original instance.
 */
export function toAppError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const code = err instanceof AppError ? err.code : e.code;
  if (!(err instanceof AppError) && e.name !== "AppError") return null;
  if (typeof code !== "string" || !KNOWN_CODES.has(code)) return null;
  const message = typeof e.message === "string" && e.message ? e.message : code;
  return new AppError(code as ErrorCode, message);
}

/**
 * Codemode's ToolDispatcher forwards only `err.message` into the sandbox, and
 * the executor only reports the sandbox's final `err.message` back. The bridge
 * encodes "CODE: message" for host failures, remembers every string it handed
 * out, and restores the typed AppError when that string (or a wrapper of it)
 * is what the script ended with. Anything else is a model-code error.
 */
export class SandboxErrorBridge {
  readonly #issued = new Map<string, AppError>();

  toSandbox(err: unknown): Error {
    let app = toAppError(err);
    if (!app) {
      log("warn", "codemode.host_fn.unexpected_error", {
        errName: err instanceof Error ? err.name : typeof err,
      });
      app = new AppError(ErrorCodes.UPSTREAM_ERROR, "Upstream request failed");
    }
    const encoded = `${app.code}: ${app.message}`;
    this.#issued.set(encoded, app);
    return new Error(encoded);
  }

  fromSandbox(error: string, timeoutMs: number): AppError {
    const exact = this.#issued.get(error);
    if (exact) return exact;
    let wrapped: { key: string; err: AppError } | undefined;
    for (const [key, err] of this.#issued) {
      if (error.includes(key) && (!wrapped || key.length > wrapped.key.length)) {
        wrapped = { key, err };
      }
    }
    if (wrapped) return wrapped.err;
    if (error === SANDBOX_TIMEOUT_MESSAGE) return timeoutError(timeoutMs);
    const tooLarge = /^RESULT_TOO_LARGE (\d+)$/.exec(error);
    if (tooLarge) {
      return new AppError(
        ErrorCodes.RESULT_LIMIT_EXCEEDED,
        `Code Mode result is ${tooLarge[1]} characters of JSON; filter, aggregate or paginate before returning`,
      );
    }
    return new AppError(ErrorCodes.INVALID_INPUT, `Code Mode script failed: ${clip(error)}`);
  }
}

/**
 * Map a rejection of executor.execute() itself (not a script-level error).
 * A module that does not compile, or a result too deeply nested to transfer,
 * is the model's mistake and is reported as INVALID_INPUT; anything else is
 * infrastructure and is rethrown.
 */
export function executorFailure(err: unknown): unknown {
  if (toAppError(err)) return err;
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (SYNTAX_ERROR.test(text)) {
    return new AppError(ErrorCodes.INVALID_INPUT, `Code Mode script did not compile: ${clip(text)}`);
  }
  if (CLONE_ERROR.test(text)) {
    return new AppError(ErrorCodes.INVALID_INPUT, "Code Mode result could not be transferred; return plain JSON values");
  }
  if (RESOURCE_LIMIT.test(text)) {
    return new AppError(ErrorCodes.RESULT_LIMIT_EXCEEDED, "Code Mode script exceeded its CPU or memory limit");
  }
  if (STACK_OVERFLOW.test(text)) {
    return new AppError(
      ErrorCodes.INVALID_INPUT,
      "Code Mode result could not be returned: it is too deeply nested; return a flatter value",
    );
  }
  return err;
}

function clip(text: string): string {
  return text.length > MAX_SCRIPT_ERROR_CHARS ? `${text.slice(0, MAX_SCRIPT_ERROR_CHARS)}…` : text;
}

export function timeoutError(timeoutMs: number): AppError {
  return new AppError(
    ErrorCodes.UPSTREAM_TIMEOUT,
    `Code Mode execution exceeded the ${timeoutMs} ms limit`,
  );
}
