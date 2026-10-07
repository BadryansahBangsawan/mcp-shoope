import { describe, expect, it } from "vitest";
import {
  applyShopeeBrowserHeaders,
  needsPageWarmup,
  refererForOperation,
  SHOPEE_SEC_CH_UA,
  SHOPEE_USER_AGENT,
} from "../../src/dispatcher/client-headers";

describe("refererForOperation", () => {
  it("maps captured XHR to the UI page that owns it", () => {
    expect(refererForOperation("orders.list")).toBe("https://shopee.co.id/user/purchase");
    expect(refererForOperation("orders.detail")).toBe("https://shopee.co.id/user/purchase");
    expect(refererForOperation("orders.count")).toBe("https://shopee.co.id/user/purchase");
    expect(refererForOperation("cart.get")).toBe("https://shopee.co.id/cart");
    expect(refererForOperation("voucher.list")).toBe("https://shopee.co.id/user/voucher-wallet");
    expect(refererForOperation("account.profile")).toBe("https://shopee.co.id/user/account/profile");
  });

  it("falls back to origin / for unknown operations", () => {
    expect(refererForOperation("nope")).toBe("https://shopee.co.id/");
  });

  it("warms up list/detail/cart/voucher.list pages, not profile or count", () => {
    expect(needsPageWarmup("orders.list")).toBe(true);
    expect(needsPageWarmup("orders.detail")).toBe(true);
    expect(needsPageWarmup("cart.get")).toBe(true);
    expect(needsPageWarmup("voucher.list")).toBe(true);
    expect(needsPageWarmup("orders.count")).toBe(false);
    expect(needsPageWarmup("account.profile")).toBe(false);
    expect(needsPageWarmup("nope")).toBe(false);
  });
});

describe("applyShopeeBrowserHeaders", () => {
  it("sets Chrome identity on XHR without anti-bot tokens", () => {
    const h = new Headers();
    applyShopeeBrowserHeaders(h, "xhr");
    expect(h.get("user-agent")).toBe(SHOPEE_USER_AGENT);
    expect(h.get("sec-ch-ua")).toBe(SHOPEE_SEC_CH_UA);
    expect(h.get("sec-ch-ua-mobile")).toBe("?0");
    expect(h.get("sec-ch-ua-platform")).toBe(`"Windows"`);
    expect(h.get("sec-fetch-mode")).toBe("cors");
    expect(h.get("x-api-source")).toBe("pc");
    expect([...h.keys()].some((k) => k.toLowerCase().startsWith("af-ac-enc"))).toBe(false);
  });

  it("does not put XHR source headers on HTML navigations", () => {
    const h = new Headers();
    applyShopeeBrowserHeaders(h, "html");
    expect(h.get("x-api-source")).toBeNull();
    expect(h.get("x-requested-with")).toBeNull();
    expect(h.get("sec-fetch-mode")).toBe("navigate");
  });
});
