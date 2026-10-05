import { describe, expect, it } from "vitest";
import {
  HOSTS,
  assertAllowedUrl,
  hostKeyForName,
  isBuyerShopeeDomain,
  isShopeeLoginUrl,
  resolveHost,
} from "../../src/dispatcher/allowlist";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import type { HostKey } from "../../src/registry/types";

function rejected(url: string | URL): AppError {
  try {
    assertAllowedUrl(typeof url === "string" ? new URL(url) : url);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCodes.HOST_NOT_ALLOWED);
    return err as AppError;
  }
  throw new Error(`expected HOST_NOT_ALLOWED for ${url}`);
}

describe("allowlist", () => {
  it("allowlists only shopee.co.id on host key www", () => {
    expect(HOSTS).toEqual({ www: "shopee.co.id" });
    expect(Object.keys(HOSTS)).toEqual(["www"]);
    expect(() => assertAllowedUrl(new URL("https://shopee.co.id/api/v4/account/profile"))).not.toThrow();
    expect(() => assertAllowedUrl(new URL("https://shopee.co.id:443/buyer/login"))).not.toThrow();
  });

  it("rejects http, userinfo, non-443 ports, seller, partner, and unknown hosts", () => {
    expect(rejected("http://shopee.co.id/").message).toMatch(/https/i);
    expect(rejected("https://user:pass@shopee.co.id/x").message).toMatch(/Userinfo/i);
    expect(rejected("https://shopee.co.id:8443/x").message).toMatch(/port/i);
    expect(rejected("https://evil.example/api").message).toMatch(/not allowlisted/i);
    expect(rejected("https://seller.shopee.co.id/login").message).toMatch(/not allowlisted/i);
    expect(rejected("https://partner.shopeemobile.com/api/v2/shop/get_shop_info").message).toMatch(
      /not allowlisted/i,
    );
    expect(rejected("https://mall.shopee.co.id/cart").message).toMatch(/not allowlisted/i);
    expect(rejected("https://mcp.shopee.badry.engineer/connect/paste").code).toBe(
      ErrorCodes.HOST_NOT_ALLOWED,
    );
  });

  it("rejects .. and // in the path", () => {
    expect(rejected("https://shopee.co.id/foo//bar").message).toMatch(/traversal/i);
    expect(rejected("https://shopee.co.id//api/v4/account/profile").message).toMatch(/traversal/i);
    const dotted = new URL("https://shopee.co.id/api/v4/account/profile");
    Object.defineProperty(dotted, "pathname", { value: "/api/../secret" });
    expect(rejected(dotted).message).toMatch(/traversal/i);
  });

  it("isShopeeLoginUrl matches buyer login/signin only", () => {
    expect(isShopeeLoginUrl(new URL("https://shopee.co.id/buyer/login"))).toBe(true);
    expect(isShopeeLoginUrl(new URL("https://shopee.co.id/buyer/login/?next=/"))).toBe(true);
    expect(isShopeeLoginUrl(new URL("https://shopee.co.id/buyer/signin"))).toBe(true);
    expect(isShopeeLoginUrl(new URL("https://mall.shopee.co.id/buyer/login"))).toBe(true);
    expect(isShopeeLoginUrl(new URL("https://shopee.co.id/api/v4/account/profile"))).toBe(false);
    expect(isShopeeLoginUrl(new URL("https://seller.shopee.co.id/buyer/login"))).toBe(false);
    expect(isShopeeLoginUrl(new URL("https://partner.shopeemobile.com/api/v2/shop/auth_partner"))).toBe(
      false,
    );
  });

  it("isBuyerShopeeDomain drops seller and any host containing partner", () => {
    expect(isBuyerShopeeDomain("shopee.co.id")).toBe(true);
    expect(isBuyerShopeeDomain(".shopee.co.id")).toBe(true);
    expect(isBuyerShopeeDomain("mall.shopee.co.id")).toBe(true);
    expect(isBuyerShopeeDomain("seller.shopee.co.id")).toBe(false);
    expect(isBuyerShopeeDomain("xx.seller.shopee.co.id")).toBe(false);
    expect(isBuyerShopeeDomain("partner.shopee.co.id")).toBe(false);
    expect(isBuyerShopeeDomain("partner.shopeemobile.com")).toBe(false);
    expect(isBuyerShopeeDomain("google.com")).toBe(false);
  });

  it("resolveHost maps www and refuses unknown keys", () => {
    expect(resolveHost("www")).toBe("shopee.co.id");
    expect(() => resolveHost("nope" as HostKey)).toThrow(
      expect.objectContaining({ code: ErrorCodes.HOST_NOT_ALLOWED }),
    );
  });

  it("hostKeyForName maps only shopee.co.id to www", () => {
    expect(hostKeyForName("shopee.co.id")).toBe("www");
    expect(hostKeyForName("SHOPEE.CO.ID.")).toBe("www");
    expect(hostKeyForName("mall.shopee.co.id")).toBeUndefined();
    expect(hostKeyForName("seller.shopee.co.id")).toBeUndefined();
    expect(hostKeyForName("partner.shopeemobile.com")).toBeUndefined();
    expect(hostKeyForName("mcp.shopee.badry.engineer")).toBeUndefined();
  });
});
