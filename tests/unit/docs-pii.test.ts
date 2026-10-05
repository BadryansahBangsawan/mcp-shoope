import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_DOCS } from "../../src/docs/bundled";
import { sanitizeDocMarkdown } from "../../src/observability/redact";
import { API_DOC_NAMES } from "../../src/registry/doc-endpoints";

const root = path.resolve(__dirname, "../..");
const docsDir = path.join(root, "docs");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /\+?\b62\d{8,13}\b|\b08\d{7,12}\b/;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
/** Real assignment values — placeholders like `<TOKEN>` / `<REDACTED>` are allowed. */
const REAL_CREDENTIAL_ASSIGN =
  /(?:partner_key|access_token|refresh_token)=(?!<)[^&\s"'`<>]+|&sign=(?!<)[^&\s"'`<>]+/i;

function allMarkdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? allMarkdown(path.join(dir, d.name))
      : d.name.endsWith(".md")
        ? [path.join(dir, d.name)]
        : [],
  );
}

function assertNoLeakedSecrets(text: string, label: string): void {
  expect(text, `${label} email`).not.toMatch(EMAIL);
  expect(text, `${label} phone`).not.toMatch(PHONE);
  expect(text, `${label} bearer`).not.toMatch(BEARER);
  expect(text, `${label} credential assign`).not.toMatch(REAL_CREDENTIAL_ASSIGN);
}

describe("bundled docs", () => {
  it("bundle exposes exactly the API docs, byte-equal to docs/*.md", () => {
    expect(Object.keys(BUNDLED_DOCS).sort()).toEqual([...API_DOC_NAMES].sort());
    for (const name of API_DOC_NAMES) {
      const onDisk = readFileSync(path.join(docsDir, `${name}.md`), "utf8");
      // Regenerate with `bun run scripts/bundle-docs.ts` when this fails.
      expect(BUNDLED_DOCS[name], name).toBe(onDisk);
    }
  });

  it("docs/*.md contain no emails, phones, tokens, or credential query assignments", () => {
    for (const file of allMarkdown(docsDir)) {
      assertNoLeakedSecrets(readFileSync(file, "utf8"), path.relative(root, file));
    }
  });

  it("bundled docs contain no emails, phones, tokens, or credential query assignments", () => {
    for (const [name, md] of Object.entries(BUNDLED_DOCS)) {
      assertNoLeakedSecrets(md, `bundled:${name}`);
    }
  });

  it("flags a planted credential assignment (guards against a vacuous pass)", () => {
    expect(REAL_CREDENTIAL_ASSIGN.test("access_token=realtokenvalue")).toBe(true);
    expect(REAL_CREDENTIAL_ASSIGN.test("&sign=deadbeefcafebabe")).toBe(true);
    expect(REAL_CREDENTIAL_ASSIGN.test("partner_key=supersecret")).toBe(true);
    expect(REAL_CREDENTIAL_ASSIGN.test("access_token=<TOKEN>")).toBe(false);
    expect(REAL_CREDENTIAL_ASSIGN.test("&sign=<REDACTED>")).toBe(false);
  });
});

describe("sanitizeDocMarkdown over bundled docs", () => {
  const sanitized = Object.fromEntries(
    Object.entries(BUNDLED_DOCS).map(([name, md]) => [name, sanitizeDocMarkdown(md)]),
  );

  it("leaves no emails, phones, Bearer tokens, or real credential query assignments", () => {
    for (const [name, md] of Object.entries(sanitized)) {
      assertNoLeakedSecrets(md, `sanitized:${name}`);
    }
  });

  it("redacts placeholder access_token / sign query params in bundled curl samples", () => {
    const orders = sanitized.orders ?? "";
    if (orders.includes("access_token=")) {
      expect(orders).toContain("access_token=<REDACTED>");
      expect(orders).not.toMatch(/access_token=(?!<REDACTED>)/);
    }
    if (orders.includes("&sign=")) {
      expect(orders).toContain("sign=<REDACTED>");
      expect(orders).not.toMatch(/&sign=(?!<REDACTED>)/);
    }
  });

  it("keeps buyer login METHOD URLs useful", () => {
    expect(sanitized["auth-login"]).toContain("GET https://shopee.co.id/buyer/login");
    expect(sanitized["auth-login"]).toContain("POST https://shopee.co.id/api/v2/authentication/login");
    expect(sanitized["auth-login"]).toContain("/api/v2/authentication/resend_otp");
    expect(sanitized["auth-login"]).toContain("/api/v2/authentication/vcode_login");
    expect(sanitized.orders).toContain("orders.list");
  });
});
