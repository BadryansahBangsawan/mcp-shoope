import { discardBody, readStreamCapped } from "../dispatcher/upstream";
import { AppError, ErrorCodes } from "../errors/codes";
import type { StoredOrdersSnapshot } from "../session/types";

export const ORDERS_BUNDLE_VERSION = 1;
export const ORDERS_SOURCE = "browser-export";
export const MAX_SNAPSHOT_ORDERS = 2_000;
export const MAX_SNAPSHOT_DETAILS = 2_000;
/** Larger than cookie paste: a 5-month list + details can be ~1–2 MB JSON. */
export const MAX_ORDERS_BODY_BYTES = 2_000_000;

const LIST_KEYS = ["order_list", "details", "orders", "list"] as const;
const ID_KEYS = ["order_id", "orderid", "orderId"] as const;

export function isStoredOrdersSnapshot(v: unknown): v is StoredOrdersSnapshot {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Partial<StoredOrdersSnapshot> & { password?: unknown; cookies?: unknown };
  if (s.password !== undefined || s.cookies !== undefined) return false;
  if (typeof s.pulledAt !== "number" || !Number.isFinite(s.pulledAt) || s.pulledAt <= 0) return false;
  if (s.source !== ORDERS_SOURCE) return false;
  if (!Array.isArray(s.list) || s.list.length > MAX_SNAPSHOT_ORDERS) return false;
  if (!s.details || typeof s.details !== "object" || Array.isArray(s.details)) return false;
  const ids = Object.keys(s.details);
  if (ids.length > MAX_SNAPSHOT_DETAILS) return false;
  for (const id of ids) {
    if (!/^\d{5,20}$/.test(id)) return false;
  }
  return true;
}

/**
 * Structured orders import from a real browser (Playwright sidecar). Extra keys
 * ignored. Rejects cookie jars so this endpoint cannot be used as a session paste.
 */
export function validateOrdersBundle(raw: unknown): StoredOrdersSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Orders bundle must be a JSON object");
  }
  const input = raw as Record<string, unknown>;
  if (input.v !== ORDERS_BUNDLE_VERSION) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Orders bundle v must be 1");
  }
  if (input.source !== ORDERS_SOURCE) {
    throw new AppError(ErrorCodes.INVALID_INPUT, `Orders bundle source must be ${ORDERS_SOURCE}`);
  }
  if (input.cookies !== undefined) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Orders bundle must not include cookies");
  }
  if (!Array.isArray(input.list) || input.list.length > MAX_SNAPSHOT_ORDERS) {
    throw new AppError(ErrorCodes.INVALID_INPUT, `Orders bundle list must be an array of at most ${MAX_SNAPSHOT_ORDERS}`);
  }
  const detailsRaw = input.details;
  const details: Record<string, unknown> = {};
  if (detailsRaw !== undefined) {
    if (!detailsRaw || typeof detailsRaw !== "object" || Array.isArray(detailsRaw)) {
      throw new AppError(ErrorCodes.INVALID_INPUT, "Orders bundle details must be an object");
    }
    const entries = Object.entries(detailsRaw as Record<string, unknown>);
    if (entries.length > MAX_SNAPSHOT_DETAILS) {
      throw new AppError(
        ErrorCodes.INVALID_INPUT,
        `Orders bundle details must have at most ${MAX_SNAPSHOT_DETAILS} entries`,
      );
    }
    for (const [id, value] of entries) {
      if (!/^\d{5,20}$/.test(id)) {
        throw new AppError(ErrorCodes.INVALID_INPUT, "Orders bundle detail keys must be numeric order ids");
      }
      details[id] = value;
    }
  }
  const pulledAt =
    typeof input.pulledAt === "number" && Number.isFinite(input.pulledAt) && input.pulledAt > 0
      ? Math.trunc(input.pulledAt)
      : Date.now();
  return { pulledAt, source: ORDERS_SOURCE, list: input.list, details };
}

export function listItemsFromPage(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    const v = o[key];
    if (Array.isArray(v)) return v;
  }
  if (o.data !== undefined) return listItemsFromPage(o.data);
  return [];
}

export function orderIdOf(item: unknown, depth = 0): string | undefined {
  if (item == null || depth > 4) return undefined;
  if (typeof item === "string" || typeof item === "number") {
    const s = String(item);
    return /^\d{5,20}$/.test(s) ? s : undefined;
  }
  if (typeof item !== "object") return undefined;
  if (Array.isArray(item)) {
    for (const x of item) {
      const id = orderIdOf(x, depth + 1);
      if (id) return id;
    }
    return undefined;
  }
  const o = item as Record<string, unknown>;
  for (const k of ID_KEYS) {
    const v = o[k];
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v);
      if (/^\d{5,20}$/.test(s)) return s;
    }
  }
  for (const v of Object.values(o)) {
    const id = orderIdOf(v, depth + 1);
    if (id) return id;
  }
  return undefined;
}

export function sliceOrdersList(
  snapshot: StoredOrdersSnapshot,
  query: { limit?: number; offset?: number },
): { order_list: unknown[]; details: unknown[]; next_offset?: number; pulled_at: number; from_snapshot: true } {
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)));
  const sliced = snapshot.list.slice(offset, offset + limit);
  const next = offset + sliced.length < snapshot.list.length ? offset + sliced.length : undefined;
  return {
    order_list: sliced,
    details: sliced,
    ...(next !== undefined ? { next_offset: next } : {}),
    pulled_at: snapshot.pulledAt,
    from_snapshot: true,
  };
}

export function lookupOrderDetail(snapshot: StoredOrdersSnapshot, orderId: string): unknown | undefined {
  if (snapshot.details[orderId] !== undefined) return snapshot.details[orderId];
  return snapshot.list.find((item) => orderIdOf(item) === orderId);
}

export async function readOrdersImportBody(request: Request): Promise<{ csrf?: string; bundle: unknown }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_ORDERS_BODY_BYTES) {
    discardBody(request);
    throw new AppError(ErrorCodes.INVALID_INPUT, "Request body too large");
  }
  const bytes = await readStreamCapped(request.body, {
    maxBytes: MAX_ORDERS_BODY_BYTES,
    tooLarge: () => new AppError(ErrorCodes.INVALID_INPUT, "Request body too large"),
    onReadFailed: () => new AppError(ErrorCodes.INVALID_INPUT, "Unreadable request body"),
  });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Unreadable orders body");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "JSON body must be an object");
  }
  const o = json as Record<string, unknown>;
  const raw = o.bundle !== undefined ? o.bundle : o;
  return { csrf: typeof o.csrf === "string" ? o.csrf : undefined, bundle: raw };
}
