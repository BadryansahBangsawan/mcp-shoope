import { CookieJar } from "../connect/cookie-jar";
import { looksLikeHtml, parseLoginJson, isSuccessError } from "../connect/login-parse";
import { AppError, ErrorCodes } from "../errors/codes";
import { log } from "../observability/log";
import { getOperation } from "../registry/operations";
import type { ApiOperation } from "../registry/types";
import { validateOperationInput } from "../registry/validate";
import type { ShopeeSessionContext, ShopeeSessionProvider } from "../session/types";
import { HOSTS, assertAllowedUrl, resolveHost } from "./allowlist";
import { applyQuery, buildPath, resolveUrl } from "./path";
import {
  createRequestSignals,
  fetchUpstream,
  readBodyCapped,
  type UpstreamContext,
} from "./upstream";

export interface DispatchRequest {
  operationId: string;
  /** Path params only — never an absolute URL. */
  path?: Record<string, string | number>;
  /** `undefined` values mean "not provided" and are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface DispatchResult {
  operationId: string;
  status: number;
  data: unknown;
}

export interface DispatchOptions {
  /** Must be true (and mutations enabled) for write/destructive ops. */
  allowMutation?: boolean;
  /** Aborts in-flight fetches and body reads (e.g. execution deadline). */
  signal?: AbortSignal;
}

export interface DispatcherLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

const DEFAULT_LIMITS: DispatcherLimits = {
  timeoutMs: 25_000,
  maxBytes: 2_000_000,
  maxRedirects: 3,
};

const ORIGIN = `https://${HOSTS.www}`;

const RESERVED_KEYS = new Set([
  "cookie",
  "authorization",
  "x-csrftoken",
  "csrftoken",
  "x-csrf-token",
  "set-cookie",
]);

export class ShopeeDispatcher {
  #sessions: ShopeeSessionProvider;
  #limits: DispatcherLimits;
  #fetchImpl: typeof fetch;
  #mutationsEnabled: boolean;

  constructor(options: {
    sessions: ShopeeSessionProvider;
    mutationsEnabled?: boolean;
    limits?: Partial<DispatcherLimits>;
    fetchImpl?: typeof fetch;
  }) {
    this.#sessions = options.sessions;
    this.#mutationsEnabled = options.mutationsEnabled ?? false;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Run every local check dispatch() would (operation gate, input validation,
   * session lookup, URL allowlist) without contacting Shopee.
   */
  async preflight(req: DispatchRequest, opts: DispatchOptions = {}): Promise<void> {
    await this.#prepare(req, opts);
  }

  async dispatch(req: DispatchRequest, opts: DispatchOptions = {}): Promise<DispatchResult> {
    const prepared = await this.#prepare(req, opts);
    log("info", "shopee.dispatch", {
      operationId: prepared.op.operationId,
      method: prepared.op.method,
      host: prepared.host,
      path: prepared.path,
    });
    return this.#exchange(prepared, opts);
  }

  async #exchange(prepared: Prepared, opts: DispatchOptions): Promise<DispatchResult> {
    const { deadline, signal } = createRequestSignals(this.#limits.timeoutMs, opts.signal);
    const ctx: UpstreamContext = {
      fetchImpl: this.#fetchImpl,
      deadline,
      signal,
      timeoutMs: this.#limits.timeoutMs,
      maxRedirects: this.#limits.maxRedirects,
    };
    const outcome = await fetchUpstream(prepared.url, prepared.init, ctx);
    if (outcome.kind === "login-redirect") {
      await this.#expire(prepared.op, prepared.session, "login-redirect");
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    const response = outcome.response;
    const text = await readBodyCapped(response, this.#limits.maxBytes, ctx);
    const http = this.#httpStatus(prepared.op, response.status, text);
    if (http === "auth") {
      await this.#expire(prepared.op, prepared.session, `http_${response.status}`);
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    if (http === "forbidden") {
      throw new AppError(ErrorCodes.FORBIDDEN, `Upstream forbidden (403) for ${prepared.op.operationId}`);
    }
    if (http === "rate") {
      throw new AppError(ErrorCodes.SHOPEE_RATE_LIMITED, "Upstream rate limited");
    }
    const parsed = parseEnvelope(prepared.op, response.status, text);
    if (parsed.kind === "auth") {
      await this.#expire(prepared.op, prepared.session, "error_auth");
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    if (parsed.kind === "error") throw parsed.error;
    return { operationId: prepared.op.operationId, status: response.status, data: parsed.data };
  }

  #httpStatus(op: ApiOperation, status: number, text: string): "ok" | "auth" | "forbidden" | "rate" {
    if (status === 401) return "auth";
    if (status === 429) return "rate";
    if (status === 403) {
      if (looksLikeLoginHtml(text)) return "auth";
      const parsed = tryParseJson(text);
      if (parsed !== undefined) {
        const env = parseLoginJson(parsed);
        if (isAuthError(String(env.error ?? ""), env.message)) return "auth";
      }
      return "forbidden";
    }
    void op;
    return "ok";
  }

  async #prepare(req: DispatchRequest, opts: DispatchOptions): Promise<Prepared> {
    const op = getOperation(req.operationId);
    if (!op || !op.exposed) {
      throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `Unknown operation: ${req.operationId}`);
    }
    if (op.safety !== "read") {
      if (!this.#mutationsEnabled) {
        throw new AppError(ErrorCodes.MUTATION_DISABLED, "Mutations are disabled (ENABLE_MUTATIONS!=true)");
      }
      if (opts.allowMutation !== true) {
        throw new AppError(
          ErrorCodes.MUTATION_DISABLED,
          "Write operations require the approved execute_mutation path",
        );
      }
    }

    const input = validateOperationInput(op, {
      path: req.path,
      query: definedQuery(req.query),
      body: req.body,
    });

    const session = await this.#sessions.getSession();
    const host = resolveHost(op.host);
    const path = buildPath(op.pathTemplate, input.path);
    const url = resolveUrl(host, path);
    applyQuery(url, stripReserved(input.query));
    assertAllowedUrl(url);

    const jar = CookieJar.fromJSON(session.cookies);
    const cookie = jar.headerFor(url);
    const csrf = session.csrfToken || jar.get(url, "csrftoken") || "";
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("origin", ORIGIN);
    headers.set("referer", `${ORIGIN}/`);
    headers.set("x-requested-with", "XMLHttpRequest");
    if (cookie) headers.set("cookie", cookie);
    if (csrf) headers.set("x-csrftoken", csrf);

    const init: RequestInit = { method: op.method, headers, redirect: "manual" };
    if (op.method !== "GET" && op.method !== "DELETE") {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(stripReservedBody(input.body));
    }
    return { req, op, session, host, path, url, init };
  }

  async #expire(op: ApiOperation, session: ShopeeSessionContext, reason: string): Promise<void> {
    log("warn", "shopee.session_expired", { operationId: op.operationId, reason });
    try {
      await this.#sessions.markExpired(session.fingerprint);
    } catch (err) {
      log("warn", "shopee.mark_expired_failed", {
        operationId: op.operationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

interface Prepared {
  req: DispatchRequest;
  op: ApiOperation;
  session: ShopeeSessionContext;
  host: string;
  path: string;
  url: URL;
  init: RequestInit;
}

function definedQuery(
  query: DispatchRequest["query"],
): Record<string, string | number | boolean> | undefined {
  if (query === undefined || query === null) return undefined;
  if (typeof query !== "object" || Array.isArray(query)) {
    return query as unknown as Record<string, string | number | boolean>;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function stripReserved(
  query: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(query)) {
    if (!RESERVED_KEYS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function stripReservedBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!RESERVED_KEYS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function looksLikeLoginHtml(text: string): boolean {
  if (!looksLikeHtml(text)) return false;
  const slice = text.slice(0, 8000).toLowerCase();
  return slice.includes("/buyer/login") || (slice.includes("password") && slice.includes("login"));
}

type Parsed = { kind: "ok"; data: unknown } | { kind: "auth" } | { kind: "error"; error: AppError };

function parseEnvelope(op: ApiOperation, status: number, text: string): Parsed {
  if (status >= 300 && status < 400) {
    return {
      kind: "error",
      error: new AppError(ErrorCodes.UPSTREAM_ERROR, `Unexpected upstream status ${status}`),
    };
  }
  if (looksLikeLoginHtml(text)) return { kind: "auth" };
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    return {
      kind: "error",
      error: new AppError(
        ErrorCodes.SHOPEE_RESPONSE_INVALID,
        status >= 400 ? `Upstream ${status} (non-JSON body)` : "Non-JSON upstream body",
      ),
    };
  }
  const env = parseLoginJson(json);
  if (!isSuccessError(env.error)) {
    const code = String(env.error).toLowerCase();
    if (isAuthError(code, env.message)) return { kind: "auth" };
    if (code.includes("permission") || code.includes("forbidden")) {
      return {
        kind: "error",
        error: new AppError(ErrorCodes.FORBIDDEN, env.message || `Upstream forbidden for ${op.operationId}`),
      };
    }
    if (code.includes("limit") || code.includes("too_many") || code.includes("rate")) {
      return {
        kind: "error",
        error: new AppError(ErrorCodes.SHOPEE_RATE_LIMITED, env.message || "Upstream rate limited"),
      };
    }
    return {
      kind: "error",
      error: new AppError(ErrorCodes.UPSTREAM_ERROR, env.message || `Upstream error (${env.error})`, {
        details: { error: env.error },
      }),
    };
  }
  if (status >= 400) {
    return {
      kind: "error",
      error: new AppError(ErrorCodes.UPSTREAM_ERROR, `Upstream ${status}`),
    };
  }
  return { kind: "ok", data: json };
}

function isAuthError(code: string, message = ""): boolean {
  const hay = `${code} ${message}`.toLowerCase();
  return (
    hay.includes("error_auth") ||
    hay.includes("invalid_token") ||
    hay.includes("invalid_access_token") ||
    hay.includes("error_token") ||
    hay.includes("not_login") ||
    hay.includes("need_login")
  );
}

function tryParseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}
