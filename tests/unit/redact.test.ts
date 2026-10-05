import { describe, expect, it } from "vitest";
import { redactValue, sanitizeDocMarkdown } from "../../src/observability/redact";

describe("redaction", () => {
  it("redacts secrets in objects", () => {
    const out = redactValue({
      authorization: "Bearer abcdefghijklmnop",
      nested: { cookie: "session=abc" },
    }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).cookie).toBe("[REDACTED]");
  });

  it("redacts partner_key, access_token, refresh_token, and sign object keys", () => {
    const out = redactValue({
      partner_key: "pk-secret",
      access_token: "at-secret",
      refresh_token: "rt-secret",
      sign: "deadbeef",
      shop_id: "123456",
      partner_id: "1",
    }) as Record<string, unknown>;
    expect(out.partner_key).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.sign).toBe("[REDACTED]");
    expect(out.shop_id).toBe("123456");
    expect(out.partner_id).toBe("1");
  });

  it("redacts otp, vcode, csrftoken, and x-csrftoken object keys", () => {
    const out = redactValue({
      otp: "123456",
      vcode: "AB12",
      csrftoken: "csrf-secret",
      "x-csrftoken": "csrf-header",
      username: "buyer@example.com",
    }) as Record<string, unknown>;
    expect(out.otp).toBe("[REDACTED]");
    expect(out.vcode).toBe("[REDACTED]");
    expect(out.csrftoken).toBe("[REDACTED]");
    expect(out["x-csrftoken"]).toBe("[REDACTED]");
    expect(out.username).not.toBe("[REDACTED]");
  });

  it("sanitizes doc markdown phones/emails/tokens", () => {
    const s = sanitizeDocMarkdown(
      "call 6281200000000 or +6281200000001 or 081200000000 or a@b.com Bearer TOKENTOKENTOKENTOKEN",
    );
    expect(s).not.toContain("6281200000000");
    expect(s).not.toContain("6281200000001");
    expect(s).not.toContain("081200000000");
    expect(s).not.toContain("a@b.com");
    expect(s).not.toContain("TOKENTOKENTOKENTOKEN");
  });

  it("redacts partner_key / access_token / refresh_token / sign query params", () => {
    const s = sanitizeDocMarkdown(
      "https://partner.shopeemobile.com/api/v2/shop/get_shop_info?partner_key=SECRETKEY&access_token=TOKENTOKEN&refresh_token=REFRESHME&sign=abcdef0123456789",
    );
    expect(s).toContain("partner_key=<REDACTED>");
    expect(s).toContain("access_token=<REDACTED>");
    expect(s).toContain("refresh_token=<REDACTED>");
    expect(s).toContain("sign=<REDACTED>");
    expect(s).not.toContain("SECRETKEY");
    expect(s).not.toContain("TOKENTOKEN");
    expect(s).not.toContain("REFRESHME");
    expect(s).not.toContain("abcdef0123456789");
  });

  it("keeps prose that merely mentions Bearer", () => {
    expect(sanitizeDocMarkdown("Auth is a dashboard Bearer session.")).toBe(
      "Auth is a dashboard Bearer session.",
    );
  });

  it("replaces UUIDs such as device ids", () => {
    const s = sanitizeDocMarkdown("| `device_id` | UUID | `00000000-0000-4000-8000-000000000000` |");
    expect(s).toContain("`<UUID>`");
  });

  it("redacts person fields in table sample cells, including bare digits", () => {
    const md = [
      "### `data.customer`",
      "",
      "| Field | Type | Sample | Notes |",
      "| --- | --- | --- | --- |",
      "| `id` | integer | `1001` | keep |",
      "| `fullname` | string | `Example Person/Nick` | Nickname `suffix` stays |",
      "| `mobile` | string | `81200000000` | No `62` prefix |",
      "| `name` | string | `Example Person` | |",
      "| `email` | string | `\"\"` | empty stays |",
    ].join("\n");
    const s = sanitizeDocMarkdown(md);
    expect(s).toContain("| `id` | integer | `1001` | keep |");
    expect(s).toContain("| `fullname` | string | `<PII_REDACTED>` | Nickname `suffix` stays |");
    expect(s).toContain("| `mobile` | string | `<PII_REDACTED>` | No `62` prefix |");
    expect(s).toContain("| `name` | string | `<PII_REDACTED>` | |");
    expect(s).toContain('| `email` | string | `""` | empty stays |');
  });

  it("keeps non-person field samples outside person sections", () => {
    const md = [
      "### products",
      "",
      "| Field | Type | Sample |",
      "| --- | --- | --- |",
      "| `item_name` | string | `Kaos Polos` |",
      "| `name` | string | `Example Person` |",
    ].join("\n");
    const s = sanitizeDocMarkdown(md);
    expect(s).toContain("`Kaos Polos`");
    expect(s).toContain("| `name` | string | `<PII_REDACTED>` |");
  });

  it("redacts names in person columns but keeps numeric ids", () => {
    const md = [
      "## Observed users",
      "",
      "| Source | id / name |",
      "| --- | --- | --- |",
      '| history | `"1234567"` / `Example Person` |',
    ].join("\n");
    expect(sanitizeDocMarkdown(md)).toContain('| history | `"1234567"` / `<PII_REDACTED>` |');
  });

  it("redacts JSON person fields including the `name` key; keeps item_name", () => {
    const md = [
      "## Sample",
      "",
      "```json",
      "{",
      '  "customer": { "id": 1, "name": "Example Person", "mobile": "81200000000" },',
      '  "item": { "item_name": "Kaos Polos", "item_sku": "SKU-1" }',
      "}",
      "```",
    ].join("\n");
    const s = sanitizeDocMarkdown(md);
    expect(s).not.toContain("Example Person");
    expect(s).not.toContain("81200000000");
    expect(s).toContain('"name": "<PII_REDACTED>"');
    expect(s).toContain('"item_name": "Kaos Polos"');
    expect(s).toContain('"item_sku": "SKU-1"');
  });

  it("redacts inline JSON person fields outside fences", () => {
    const s = sanitizeDocMarkdown('Shape: `{ "mobile": "81200000000", "fullname": "A B" }`');
    expect(s).toBe('Shape: `{ "mobile": "<PII_REDACTED>", "fullname": "<PII_REDACTED>" }`');
  });
});
