import { CookieJar } from "../connect/cookie-jar";
import { looksLikeHtml, parseLoginJson, isSuccessError } from "../connect/login-parse";
import { AppError, ErrorCodes } from "../errors/codes";
import { log } from "../observability/log";
import { lookupOrderDetail, sliceOrdersList } from "../orders/snapshot";
import { getOperation } from "../registry/operations";
import type { ApiOperation } from "../registry/types";
import { validateOperationInput } from "../registry/validate";
import type { ShopeeSessionContext, ShopeeSessionProvider, StoredOrdersSnapshot } from "../session/types";
import { HOSTS, assertAllowedUrl, resolveHost } from "./allowlist";
import {
  applyShopeeBrowserHeaders,
  needsPageWarmup,
  refererForOperation,
  SHOPEE_HTML_ACCEPT,
} from "./client-headers";
import { applyQuery, buildPath, resolveUrl } from "./path";
import {
  abortError,
  createRequestSignals,
  discardBody,
  fetchUpstream,
  readBodyCapped,
  type UpstreamContext,
} from "./upstream";
import { fillVoucherListBody } from "./voucher-defaults";

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

/** HTML GET of the UI page before list XHR. Separate from the 25s API budget. */
const PAGE_WARMUP_TIMEOUT_MS = 8_000;

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
  #ordersSnapshot?: () => Promise<StoredOrdersSnapshot | null>;

  constructor(options: {
    sessions: ShopeeSessionProvider;
    mutationsEnabled?: boolean;
    limits?: Partial<DispatcherLimits>;
    fetchImpl?: typeof fetch;
    /** Headed-browser pull; served only for orders.list/detail after 403 or expired jar. */
    ordersSnapshot?: () => Promise<StoredOrdersSnapshot | null>;
  }) {
    this.#sessions = options.sessions;
    this.#mutationsEnabled = options.mutationsEnabled ?? false;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#ordersSnapshot = options.ordersSnapshot;
  }

  /**
   * Run every local check dispatch() would (operation gate, input validation,
   * session lookup, URL allowlist) without contacting Shopee.
   */
  async preflight(req: DispatchRequest, opts: DispatchOptions = {}): Promise<void> {
    await this.#prepare(req, opts);
  }

  async dispatch(req: DispatchRequest, opts: DispatchOptions = {}): Promise<DispatchResult> {
    let prepared: Prepared;
    try {
      prepared = await this.#prepare(req, opts);
    } catch (err) {
      const served = await this.#serveOrdersSnapshot(req, err);
      if (served) return served;
      throw err;
    }
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
    if (needsPageWarmup(prepared.op.operationId)) {
      await this.#warmupPage(prepared, ctx);
    }
    const outcome = await fetchUpstream(prepared.url, prepared.init, ctx);
    if (outcome.kind === "login-redirect") {
      await this.#expire(prepared.op, prepared.session, "login-redirect");
      const served = await this.#serveOrdersSnapshot(prepared.req);
      if (served) return served;
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    const response = outcome.response;
    const text = await readBodyCapped(response, this.#limits.maxBytes, ctx);
    const http = this.#httpStatus(prepared.op, response.status, text);
    if (http === "auth") {
      await this.#expire(prepared.op, prepared.session, `http_${response.status}`);
      const served = await this.#serveOrdersSnapshot(prepared.req);
      if (served) return served;
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    if (http === "forbidden") {
      const snippet = text.trim().startsWith("{") ? text.replace(/\s+/g, " ").slice(0, 160) : "nonjson";
      log("warn", "shopee.forbidden", { operationId: prepared.op.operationId, snippet });
      const served = await this.#serveOrdersSnapshot(prepared.req);
      if (served) return served;
      throw new AppError(ErrorCodes.FORBIDDEN, `Upstream forbidden (403) for ${prepared.op.operationId}`);
    }
    if (http === "rate") {
      throw new AppError(ErrorCodes.SHOPEE_RATE_LIMITED, "Upstream rate limited");
    }
    const parsed = parseEnvelope(prepared.op, response.status, text);
    if (parsed.kind === "auth") {
      await this.#expire(prepared.op, prepared.session, "error_auth");
      const served = await this.#serveOrdersSnapshot(prepared.req);
      if (served) return served;
      throw new AppError(ErrorCodes.SHOPEE_AUTH_EXPIRED, "Sesi Shopee kedaluwarsa; sambungkan lagi di /connect");
    }
    if (parsed.kind === "error") throw parsed.error;
    return { operationId: prepared.op.operationId, status: response.status, data: parsed.data };
  }

  #httpStatus(op: ApiOperation, status: number, text: string): "ok" | "auth" | "forbidden" | "rate" {
    if (status === 401) return "auth";
    if (status === 429) return "rate";
    if (status === 403) {
      // Login-HTML is an expired session. JSON (even error_auth) is FORBIDDEN; keep the jar.
      if (looksLikeLoginHtml(text)) return "auth";
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
    // CSRF is a cookie+header pair. Prefer the jar token; if only session.csrfToken
    // exists, inject it so POSTs (cart/voucher) are not 403'd for a missing cookie.
    if (session.csrfToken && !jar.get(url, "csrftoken")) {
      jar.set(url, "csrftoken", session.csrfToken);
    }
    const cookie = jar.headerFor(url);
    const csrf = jar.get(url, "csrftoken") || session.csrfToken || "";
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("origin", ORIGIN);
    headers.set("referer", refererForOperation(op.operationId));
    applyShopeeBrowserHeaders(headers, "xhr");
    if (cookie) headers.set("cookie", cookie);
    if (csrf) headers.set("x-csrftoken", csrf);

    const init: RequestInit = { method: op.method, headers, redirect: "manual" };
    if (op.method !== "GET" && op.method !== "DELETE") {
      headers.set("content-type", "application/json");
      const stripped = stripReservedBody(input.body);
      init.body = JSON.stringify(
        op.operationId === "voucher.list" ? fillVoucherListBody(stripped) : stripped,
      );
    }
    return { req, op, session, host, path, url, init, jar };
  }

  /**
   * GET the UI page that owns this XHR so Shopee can set page cookies.
   * Apply Set-Cookie to the in-memory jar for this dispatch only — the session
   * provider has no save(). Never expire the jar from a warmup failure.
   */
  async #warmupPage(prepared: Prepared, ctx: UpstreamContext): Promise<void> {
    const pageUrl = new URL(refererForOperation(prepared.op.operationId));
    if (pageUrl.pathname === "/") return;
    try {
      assertAllowedUrl(pageUrl);
    } catch {
      return;
    }
    const headers = new Headers();
    headers.set("accept", SHOPEE_HTML_ACCEPT);
    headers.set("origin", ORIGIN);
    headers.set("referer", `${ORIGIN}/`);
    applyShopeeBrowserHeaders(headers, "html");
    const cookie = prepared.jar.headerFor(pageUrl);
    if (cookie) headers.set("cookie", cookie);

    const timeout = AbortSignal.timeout(PAGE_WARMUP_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, ctx.signal]);
    const fetchImpl = this.#fetchImpl;
    try {
      const res = await fetchImpl(pageUrl.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
      prepared.jar.applyResponse(pageUrl, res.headers);
      discardBody(res);
    } catch (err) {
      if (ctx.signal.aborted) throw abortError(ctx);
      log("warn", "shopee.page_warmup_failed", {
        operationId: prepared.op.operationId,
        path: pageUrl.pathname,
        err: err instanceof Error ? err.name : "error",
      });
      return;
    }

    const xhrHeaders = prepared.init.headers;
    if (!(xhrHeaders instanceof Headers)) return;
    const nextCookie = prepared.jar.headerFor(prepared.url);
    if (nextCookie) xhrHeaders.set("cookie", nextCookie);
    const csrf = prepared.jar.get(prepared.url, "csrftoken") || prepared.session.csrfToken || "";
    if (csrf) xhrHeaders.set("x-csrftoken", csrf);
  }

  async #serveOrdersSnapshot(req: DispatchRequest, reason?: unknown): Promise<DispatchResult | null> {
    const id = req.operationId;
    if (id !== "orders.list" && id !== "orders.detail") return null;
    if (reason !== undefined) {
      if (!(reason instanceof AppError) || reason.code !== ErrorCodes.SHOPEE_AUTH_EXPIRED) return null;
    }
    if (!this.#ordersSnapshot) return null;
    let snapshot: StoredOrdersSnapshot | null;
    try {
      snapshot = await this.#ordersSnapshot();
    } catch {
      return null;
    }
    if (!snapshot) return null;
    if (id === "orders.list") {
      const q = req.query ?? {};
      const page = sliceOrdersList(snapshot, {
        limit: typeof q.limit === "number" ? q.limit : undefined,
        offset: typeof q.offset === "number" ? q.offset : undefined,
      });
      log("info", "shopee.orders_snapshot", {
        operationId: id,
        listCount: snapshot.list.length,
        detailCount: Object.keys(snapshot.details).length,
      });
      return { operationId: id, status: 200, data: { error: 0, data: page } };
    }
    const orderId = String(req.query?.order_id ?? "");
    const detail = lookupOrderDetail(snapshot, orderId);
    if (detail === undefined) return null;
    log("info", "shopee.orders_snapshot", {
      operationId: id,
      listCount: snapshot.list.length,
      detailCount: Object.keys(snapshot.details).length,
    });
    return {
      operationId: id,
      status: 200,
      data: { error: 0, data: detail, from_snapshot: true, pulled_at: snapshot.pulledAt },
    };
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
  jar: CookieJar;
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

