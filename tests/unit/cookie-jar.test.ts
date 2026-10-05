import { describe, expect, it } from "vitest";
import {
  CookieJar,
  MAX_COOKIES,
  MAX_VALUE_LEN,
  isStoredCookie,
} from "../../src/connect/cookie-jar";
import type { StoredCookie } from "../../src/session/types";

const WWW = new URL("https://shopee.co.id/");
const MALL = new URL("https://mall.shopee.co.id/cart");

function cookie(extra: Partial<StoredCookie> & Pick<StoredCookie, "name" | "value">): StoredCookie {
  return {
    domain: "shopee.co.id",
    hostOnly: true,
    path: "/",
    ...extra,
  };
}

function headers(...setCookie: string[]): Headers {
  const h = new Headers();
  for (const line of setCookie) h.append("set-cookie", line);
  return h;
}

describe("isStoredCookie", () => {
  it("accepts buyer hosts and rejects seller/partner/third-party", () => {
    expect(isStoredCookie(cookie({ name: "SPC_EC", value: "x" }))).toBe(true);
    expect(
      isStoredCookie(cookie({ name: "SPC_EC", value: "x", domain: "mall.shopee.co.id", hostOnly: false })),
    ).toBe(true);
    expect(isStoredCookie(cookie({ name: "SPC_EC", value: "x", domain: "seller.shopee.co.id" }))).toBe(
      false,
    );
    expect(
      isStoredCookie(cookie({ name: "SPC_EC", value: "x", domain: "partner.shopeemobile.com" })),
    ).toBe(false);
    expect(isStoredCookie(cookie({ name: "SPC_EC", value: "x", domain: "google.com" }))).toBe(false);
    expect(isStoredCookie({ name: "bad name", value: "x", domain: "shopee.co.id", hostOnly: true, path: "/" })).toBe(
      false,
    );
  });
});

describe("CookieJar Set-Cookie", () => {
  it("stores host-only cookies and Domain=.shopee.co.id as domain cookies", () => {
    const jar = new CookieJar();
    jar.applySetCookie(WWW, "SPC_EC=hostonly; Path=/");
    jar.applySetCookie(WWW, "csrftoken=csrf-value; Path=/; Domain=.shopee.co.id");
    expect(jar.get(WWW, "SPC_EC")).toBe("hostonly");
    expect(jar.get(WWW, "csrftoken")).toBe("csrf-value");
    expect(jar.get(MALL, "SPC_EC")).toBeNull();
    expect(jar.get(MALL, "csrftoken")).toBe("csrf-value");
    const stored = jar.toJSON();
    expect(stored.find((c) => c.name === "SPC_EC")?.hostOnly).toBe(true);
    expect(stored.find((c) => c.name === "csrftoken")?.hostOnly).toBe(false);
    expect(stored.find((c) => c.name === "csrftoken")?.domain).toBe("shopee.co.id");
  });

  it("drops seller, partner, and Domain attrs that are not a suffix of the request host", () => {
    const jar = new CookieJar();
    jar.applySetCookie(WWW, "SPC_EC=ok; Path=/");
    jar.applySetCookie(WWW, "x=1; Domain=seller.shopee.co.id");
    jar.applySetCookie(WWW, "y=1; Domain=partner.shopee.co.id");
    jar.applySetCookie(WWW, "z=1; Domain=mall.shopee.co.id");
    jar.applySetCookie(WWW, "g=1; Domain=google.com");
    jar.applySetCookie(new URL("https://seller.shopee.co.id/"), "SPC_EC=seller; Path=/");
    expect(jar.toJSON()).toEqual([
      expect.objectContaining({ name: "SPC_EC", value: "ok", domain: "shopee.co.id" }),
    ]);
  });

  it("Max-Age 0 and a past Expires delete; Max-Age wins over Expires", () => {
    const now = 1_700_000_000_000;
    const jar = new CookieJar([cookie({ name: "SPC_EC", value: "live" })]);
    jar.applySetCookie(WWW, "SPC_EC=gone; Max-Age=0", now);
    expect(jar.get(WWW, "SPC_EC", now)).toBeNull();

    jar.applySetCookie(WWW, "csrftoken=a; Path=/");
    jar.applySetCookie(WWW, "csrftoken=b; Expires=Thu, 01 Jan 1970 00:00:00 GMT", now);
    expect(jar.get(WWW, "csrftoken", now)).toBeNull();

    jar.applySetCookie(
      WWW,
      "keep=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      now,
    );
    expect(jar.get(WWW, "keep", now)).toBe("1");
    expect(jar.get(WWW, "keep", now + 61_000)).toBeNull();
  });

  it("evicts the oldest cookie when the jar exceeds 64", () => {
    const jar = new CookieJar();
    for (let i = 0; i < MAX_COOKIES + 3; i++) {
      jar.set(WWW, `c${i}`, "v");
    }
    const names = jar.toJSON().map((c) => c.name);
    expect(names).toHaveLength(MAX_COOKIES);
    expect(names[0]).toBe("c3");
    expect(names).not.toContain("c0");
    expect(names).toContain(`c${MAX_COOKIES + 2}`);
  });

  it("drops over-long values and invalid names", () => {
    const jar = new CookieJar();
    jar.applySetCookie(WWW, `ok=${"a".repeat(MAX_VALUE_LEN)}; Path=/`);
    jar.applySetCookie(WWW, `too=${"b".repeat(MAX_VALUE_LEN + 1)}; Path=/`);
    jar.applySetCookie(WWW, "bad name=x; Path=/");
    expect(jar.get(WWW, "ok")?.length).toBe(MAX_VALUE_LEN);
    expect(jar.get(WWW, "too")).toBeNull();
  });
});

describe("CookieJar headerFor / path", () => {
  it("sends longer paths first and omits cookies that do not match the path", () => {
    const jar = new CookieJar([
      cookie({ name: "root", value: "r", path: "/" }),
      cookie({ name: "api", value: "a", path: "/api" }),
      cookie({ name: "v4", value: "v", path: "/api/v4" }),
    ]);
    expect(jar.headerFor(new URL("https://shopee.co.id/api/v4/account/profile"))).toBe(
      "v4=v; api=a; root=r",
    );
    expect(jar.headerFor(new URL("https://shopee.co.id/buyer/login"))).toBe("root=r");
  });

  it("fromJSON drops malformed entries", () => {
    const jar = CookieJar.fromJSON([
      cookie({ name: "SPC_EC", value: "ok" }),
      { name: "x", value: "y", domain: "evil.test", hostOnly: true, path: "/" },
      "nope",
    ]);
    expect(jar.toJSON()).toEqual([expect.objectContaining({ name: "SPC_EC", value: "ok" })]);
  });

  it("applyResponse reads every Set-Cookie", () => {
    const jar = new CookieJar();
    jar.applyResponse(
      WWW,
      headers("SPC_EC=ec; Path=/", "csrftoken=csrf-value; Path=/; Domain=.shopee.co.id"),
    );
    expect(jar.headerFor(WWW)).toContain("SPC_EC=ec");
    expect(jar.headerFor(WWW)).toContain("csrftoken=csrf-value");
  });
});
