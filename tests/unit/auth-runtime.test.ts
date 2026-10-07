import { afterEach, describe, expect, it } from "vitest";
import {
  LOGIN_FALLBACK_URL,
  LOGIN_URL,
  cookieNamesLine,
  hasSessionCookie,
  toPasteBundle,
  workerBase,
} from "../../scripts/runtime";

describe("auth runtime helpers", () => {
  afterEach(() => {
    delete process.env.SHOPEE_MCP_BASE;
  });

  it("keeps buyer cookies, drops seller/partner, requires SPC_EC or SPC_ST", () => {
    const bundle = toPasteBundle([
      { name: "SPC_EC", value: "ec", domain: ".shopee.co.id", path: "/", expires: 1_735_689_600 },
      { name: "SPC_SI", value: "si", domain: "www.shopee.co.id", path: "/" },
      { name: "SPC_EC", value: "seller-ec", domain: "seller.shopee.co.id", path: "/" },
      { name: "SID", value: "google", domain: ".google.com", path: "/" },
      { name: "session", value: "x", domain: ".shopee.co.id", path: "/", expires: -1 },
    ]);
    expect(bundle.v).toBe(1);
    expect(bundle.source).toBe("browser-export");
    expect(bundle.cookies.map((c) => `${c.domain}:${c.name}`).sort()).toEqual([
      ".shopee.co.id:SPC_EC",
      ".shopee.co.id:session",
      "www.shopee.co.id:SPC_SI",
    ]);
    expect(bundle.cookies.find((c) => c.name === "SPC_EC")?.expires).toBe(1_735_689_600);
    expect(bundle.cookies.find((c) => c.name === "session")?.expires).toBeUndefined();
    expect(hasSessionCookie(bundle)).toBe(true);
    expect(hasSessionCookie({ cookies: [{ name: "SPC_SI" }] })).toBe(false);
    expect(cookieNamesLine(bundle)).toBe("SPC_EC, SPC_SI, session");
  });

  it("opens the official Shopee QR page (sidecar; not a Worker hop)", () => {
    expect(LOGIN_URL).toBe("https://shopee.co.id/buyer/login/qr");
    expect(LOGIN_FALLBACK_URL).toBe("https://shopee.co.id/buyer/login");
  });

  it("workerBase defaults to production and honours SHOPEE_MCP_BASE", () => {
    expect(workerBase()).toBe("https://mcp.shopee.badry.engineer");
    process.env.SHOPEE_MCP_BASE = "http://127.0.0.1:8787/";
    expect(workerBase()).toBe("http://127.0.0.1:8787");
  });
});
