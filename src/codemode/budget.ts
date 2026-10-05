import { AppError, ErrorCodes } from "../errors/codes";

/** Per-execution limits for one search / execute tool call. */
export interface CodemodeLimits {
  /** Host-enforced wall-clock deadline for the whole script. */
  timeoutMs: number;
  /** codemode.request() calls allowed per execution (counted on entry). */
  maxRequests: number;
  /** Upstream requests in flight at once; extra calls wait for a slot. */
  maxConcurrency: number;
  /** Cumulative JSON.stringify length of request results (≈ bytes). */
  maxResponseChars: number;
  /** codemode.spec() calls allowed per execution. */
  maxSpecCalls: number;
  /** Largest JSON result the sandbox may hand back to the host (checked inside the sandbox). */
  maxSandboxResultChars: number;
  /** Final tool text cap, in ~4-char tokens. */
  maxOutputTokens: number;
  /** CPU limit requested for the dynamic Worker isolate. */
  cpuMs: number;
}

export const DEFAULT_CODEMODE_LIMITS: CodemodeLimits = {
  timeoutMs: 30_000,
  maxRequests: 50,
  maxConcurrency: 4,
  maxResponseChars: 5_000_000,
  maxSpecCalls: 20,
  maxSandboxResultChars: 1_000_000,
  maxOutputTokens: 6_000,
  cpuMs: 10_000,
};

/**
 * Host-side accounting for one Code Mode execution. The sandbox cannot see or
 * reset any of this state; every host function checks it before doing work.
 * Exceeding a limit is terminal: the execution is aborted with that error, so a
 * script cannot catch it and keep calling.
 */
export class ExecutionBudget {
  readonly #limits: CodemodeLimits;
  readonly #controller = new AbortController();
  readonly #waiters: Array<() => void> = [];
  #requests = 0;
  #specCalls = 0;
  #inFlight = 0;
  #responseChars = 0;

  constructor(limits: CodemodeLimits) {
    this.#limits = limits;
  }

  /** Aborted when the deadline passes or the execution finishes. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Stop the execution; later host calls and queued waiters fail with `reason`. */
  abort(reason: AppError): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  #fail(message: string): AppError {
    const err = new AppError(ErrorCodes.RESULT_LIMIT_EXCEEDED, message);
    this.abort(err);
    return err;
  }

  assertActive(): void {
    if (!this.signal.aborted) return;
    const reason: unknown = this.signal.reason;
    throw reason instanceof AppError
      ? reason
      : new AppError(ErrorCodes.UPSTREAM_TIMEOUT, "Code Mode execution stopped");
  }

  countRequest(): void {
    this.assertActive();
    if (this.#requests >= this.#limits.maxRequests) {
      throw this.#fail(
        `Request limit reached: at most ${this.#limits.maxRequests} codemode.request() calls per execution`,
      );
    }
    this.#requests++;
  }

  countSpecCall(): void {
    this.assertActive();
    if (this.#specCalls >= this.#limits.maxSpecCalls) {
      throw this.#fail(
        `Spec limit reached: at most ${this.#limits.maxSpecCalls} codemode.spec() calls per execution`,
      );
    }
    this.#specCalls++;
  }

  /** Wait for an upstream slot. Resolves to a release function (idempotent). */
  async acquireSlot(): Promise<() => void> {
    while (this.#inFlight >= this.#limits.maxConcurrency) {
      this.assertActive();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(this.signal.reason);
        this.signal.addEventListener("abort", onAbort, { once: true });
        this.#waiters.push(() => {
          this.signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    this.assertActive();
    this.#inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight--;
      this.#waiters.shift()?.();
    };
  }

  /** Charge a result against the cumulative response budget. */
  chargeResponse(value: unknown): void {
    let size = 0;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      throw new AppError(ErrorCodes.UPSTREAM_ERROR, "Upstream result is not serializable");
    }
    this.#responseChars += size;
    if (this.#responseChars > this.#limits.maxResponseChars) {
      throw this.#fail(
        `Response budget exceeded: results may total at most ${this.#limits.maxResponseChars} characters per execution; request fewer or smaller pages`,
      );
    }
  }
}
