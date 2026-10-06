import { describe, expect, it } from "vitest";
import { validatePasteBundle } from "../../src/connect/paste";
import { ErrorCodes } from "../../src/errors/codes";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    source: "browser-export",
    cookies: [
      { name: "SPC_EC", value: "ec-value", domain: ".shopee.co.id", path: "/" },
      { name: "csrftoken", value: "csrf-token-value", domain: "shopee.co.id", path: "/" },
      { name: "SPC_U", value: "123456789", domain: ".shopee.co.id", path: "/" },
    ],
    ...overrides,
  };
}

function invalid(raw: unknown): { code: string; message: string } {
  try {
    validatePasteBundle(raw);
  } catch (err) {
    expect(err).toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    return err as { code: string; message: string };
  }
  throw new Error("expected INVALID_INPUT");
}

describe("validatePasteBundle", () => {
  it("accepts a v1 browser-export bundle and extracts csrf + SPC_U userId", () => {
    const out = validatePasteBundle(bundle());
    expect(out.csrfToken).toBe("csrf-token-value");
    expect(out.userId).toBe("123456789");
    expect(out.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "SPC_EC", value: "ec-value", domain: "shopee.co.id", hostOnly: false }),
        expect.objectContaining({ name: "csrftoken", value: "csrf-token-value", hostOnly: true }),
      ]),
    );
  });

  it("ignores extra keys and drops seller/partner/third-party domains without throwing", () => {
    const out = validatePasteBundle(
      bundle({
        foo: 1,
        cookies: [
          { name: "SPC_EC", value: "ec", domain: "shopee.co.id", path: "/" },
          { name: "SID", value: "google", domain: ".google.com", path: "/" },
          { name: "seller", value: "no", domain: "seller.shopee.co.id", path: "/" },
          { name: "partner", value: "no", domain: "partner.shopee.co.id", path: "/" },
        ],
      }),
    );
    expect(out.cookies).toHaveLength(1);
    expect(out.cookies[0]?.name).toBe("SPC_EC");
    expect(out.userId).toBeUndefined();
  });

  it("treats Playwright expires as unix seconds unless already ms", () => {
    const seconds = validatePasteBundle(
      bundle({
        cookies: [{ name: "SPC_EC", value: "ec", domain: "shopee.co.id", path: "/", expires: 1_800_000_000 }],
      }),
    );
    expect(seconds.cookies[0]?.expiresAt).toBe(1_800_000_000_000);

    const ms = validatePasteBundle(
      bundle({
        cookies: [{ name: "SPC_EC", value: "ec", domain: "shopee.co.id", path: "/", expires: 1_800_000_000_000 }],
      }),
    );
    expect(ms.cookies[0]?.expiresAt).toBe(1_800_000_000_000);
  });

  it("does not set userId when SPC_U is not all digits", () => {
    const out = validatePasteBundle(
      bundle({
        cookies: [
          { name: "SPC_EC", value: "ec", domain: "shopee.co.id", path: "/" },
          { name: "SPC_U", value: "not-digits", domain: "shopee.co.id", path: "/" },
        ],
      }),
    );
    expect(out.userId).toBeUndefined();
  });

  it("rejects buyer cookies without SPC_EC or SPC_ST", () => {
    expect(
      invalid(
        bundle({
          cookies: [{ name: "csrftoken", value: "csrf-token-value", domain: "shopee.co.id", path: "/" }],
        }),
      ).message,
    ).toMatch(/SPC_EC or SPC_ST/);
  });

  it("accepts SPC_ST as the session cookie", () => {
    const out = validatePasteBundle(
      bundle({
        cookies: [{ name: "SPC_ST", value: "st-value", domain: "shopee.co.id", path: "/" }],
      }),
    );
    expect(out.cookies[0]).toMatchObject({ name: "SPC_ST", value: "st-value" });
  });

  it("rewrites www.shopee.co.id host-only cookies to the apex so they are sent to shopee.co.id", () => {
    const out = validatePasteBundle(
      bundle({
        cookies: [{ name: "SPC_EC", value: "ec", domain: "www.shopee.co.id", path: "/" }],
      }),
    );
    expect(out.cookies[0]).toMatchObject({ name: "SPC_EC", domain: "shopee.co.id", hostOnly: false });
  });

  it("rejects wrong version/source, empty remaining cookies, and invalid cookie objects", () => {
    expect(invalid(null).message).toMatch(/JSON object/);
    expect(invalid([]).message).toMatch(/JSON object/);
    expect(invalid(bundle({ v: 2 })).message).toMatch(/v must be 1/);
    expect(invalid(bundle({ source: "devtools" })).message).toMatch(/browser-export/);
    expect(
      invalid(
        bundle({
          cookies: [{ name: "SID", value: "x", domain: ".google.com", path: "/" }],
        }),
      ).message,
    ).toMatch(/no cookies on shopee.co.id/);
    expect(invalid(bundle({ cookies: ["nope"] })).message).toMatch(/must be an object/);
    expect(
      invalid(
        bundle({
          cookies: [{ name: "bad name", value: "x", domain: "shopee.co.id" }],
        }),
      ).message,
    ).toMatch(/Cookie name/);
    expect(
      invalid(
        bundle({
          cookies: [{ name: "SPC_EC", value: "has;semi", domain: "shopee.co.id" }],
        }),
      ).message,
    ).toMatch(/printable ASCII/);
  });
});
