/**
 * Minimal `cloudflare:workers` stand-in for vitest (Node). Only the class
 * shapes imported by src/ and @cloudflare/codemode are provided; nothing here
 * emulates Workers runtime behaviour.
 */
export class RpcTarget {}

export class WorkerEntrypoint<E = unknown> {
  protected ctx: unknown;
  protected env: E;
  constructor(ctx?: unknown, env?: E) {
    this.ctx = ctx;
    this.env = env as E;
  }
}

export class DurableObject<E = unknown> {
  protected ctx: unknown;
  protected env: E;
  constructor(ctx?: unknown, env?: E) {
    this.ctx = ctx;
    this.env = env as E;
  }
}

export const env: Record<string, unknown> = {};
