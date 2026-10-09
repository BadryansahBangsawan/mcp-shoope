import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../src/errors/codes";
import {
  listItemsFromPage,
  lookupOrderDetail,
  orderIdOf,
  sliceOrdersList,
  validateOrdersBundle,
} from "../../src/orders/snapshot";
import type { StoredOrdersSnapshot } from "../../src/session/types";

const ID = "123456789012345";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    source: "browser-export",
    pulledAt: 1_778_173_200_000,
    list: [{ order_id: ID, status: 1 }],
    details: { [ID]: { order_id: ID, items: [] } },
    ...overrides,
  };
}

function invalid(raw: unknown): { code: string; message: string } {
  try {
    validateOrdersBundle(raw);
  } catch (err) {
    expect(err).toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    return err as { code: string; message: string };
  }
  throw new Error("expected INVALID_INPUT");
}

describe("validateOrdersBundle", () => {
  it("accepts a v1 browser-export list+details without cookies", () => {
    const out = validateOrdersBundle(bundle());
    expect(out.source).toBe("browser-export");
    expect(out.list).toHaveLength(1);
    expect(out.details[ID]).toEqual({ order_id: ID, items: [] });
    expect(out.pulledAt).toBe(1_778_173_200_000);
  });

  it("rejects cookie jars so this is not a session paste", () => {
    expect(invalid(bundle({ cookies: [{ name: "SPC_EC", value: "x" }] })).message).toMatch(/cookies/);
  });

  it("rejects wrong version/source and non-numeric detail keys", () => {
    expect(invalid(bundle({ v: 2 })).message).toMatch(/v must be 1/);
    expect(invalid(bundle({ source: "login" })).message).toMatch(/browser-export/);
    expect(invalid(bundle({ details: { nope: {} } })).message).toMatch(/numeric order ids/);
  });
});

describe("listItemsFromPage / orderIdOf", () => {
  it("unwraps data.order_list and nested order_id", () => {
    expect(listItemsFromPage({ error: 0, data: { order_list: [{ order_id: ID }] } })).toEqual([{ order_id: ID }]);
    expect(orderIdOf({ info: { order_id: ID } })).toBe(ID);
    expect(orderIdOf({ a: { b: { c: { d: { e: { order_id: ID } } } } } })).toBeUndefined();
  });
});

describe("sliceOrdersList / lookupOrderDetail", () => {
  const snapshot: StoredOrdersSnapshot = {
    pulledAt: 1_778_173_200_000,
    source: "browser-export",
    list: [{ order_id: "11111" }, { order_id: "22222" }, { order_id: "33333" }],
    details: { "11111": { order_id: "11111", full: true } },
  };

  it("pages with cap 100 and sets from_snapshot", () => {
    const page = sliceOrdersList(snapshot, { limit: 1, offset: 1 });
    expect(page.order_list).toEqual([{ order_id: "22222" }]);
    expect(page.next_offset).toBe(2);
    expect(page.from_snapshot).toBe(true);
    expect(sliceOrdersList(snapshot, { limit: 50, offset: 2 }).next_offset).toBeUndefined();
  });

  it("looks up details then falls back to list items", () => {
    expect(lookupOrderDetail(snapshot, "11111")).toEqual({ order_id: "11111", full: true });
    expect(lookupOrderDetail(snapshot, "22222")).toEqual({ order_id: "22222" });
    expect(lookupOrderDetail(snapshot, "99999")).toBeUndefined();
  });
});
