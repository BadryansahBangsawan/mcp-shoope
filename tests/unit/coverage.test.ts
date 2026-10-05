import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCoverage } from "../../src/registry/checks";
import {
  OPERATION_CONTRACT_TEST,
  buildCoverageManifest,
  coverageKey,
  coverageSummary,
} from "../../src/registry/coverage";
import { renderCoverageMarkdown } from "../../src/registry/coverage-report";
import {
  API_DOC_NAMES,
  extractDocEndpoints,
  parseDocUrl,
} from "../../src/registry/doc-endpoints";
import { EXCLUSIONS, SESSION_ONLY } from "../../src/registry/exclusions";
import { hostBaseUrl } from "../../src/registry/openapi";
import {
  OPERATIONS,
  listExposedOperations,
  listMutationOperations,
} from "../../src/registry/operations";
import type { ApiOperation, CoverageEntry } from "../../src/registry/types";

const root = path.resolve(__dirname, "../..");
const DISPATCHER_MODULE = "src/dispatcher/shopee-dispatcher.ts";
const SESSION_ONLY_TEST = "tests/unit/connect.test.ts";
const SESSION_ONLY_IMPL = "src/connect/login-flow.ts";

const docs = Object.fromEntries(
  API_DOC_NAMES.map((n) => [`${n}.md`, readFileSync(path.join(root, "docs", `${n}.md`), "utf8")]),
);
const fileExists = (p: string) => existsSync(path.join(root, p));
const docEndpoints = extractDocEndpoints(docs);
const manifest = buildCoverageManifest();

function run(overrides: {
  manifest?: CoverageEntry[];
  operations?: ApiOperation[];
  docs?: Record<string, string>;
}): string[] {
  return checkCoverage({
    manifest: overrides.manifest ?? manifest,
    operations: overrides.operations ?? OPERATIONS,
    docEndpoints: overrides.docs ? extractDocEndpoints(overrides.docs) : docEndpoints,
    fileExists,
  });
}

describe("coverage manifest vs docs/*.md", () => {
  it("every documented METHOD+host+path has exactly one entry and nothing else drifts", () => {
    expect(run({})).toEqual([]);
  });

  it("covers the captured endpoint set with stable totals", () => {
    const unique = new Set(docEndpoints.map(coverageKey));
    expect(unique.size).toBe(17);
    expect(manifest).toHaveLength(17);
    expect(coverageSummary()).toEqual({
      total: 17,
      implemented: 12,
      htmlAdapter: 0,
      mutationGated: 0,
      sessionOnly: 4,
      excluded: 1,
    });
    expect(listExposedOperations()).toHaveLength(12);
    expect(listMutationOperations()).toEqual([]);
    expect(OPERATIONS.map((o) => o.operationId).sort()).toEqual(
      [
        "account.profile",
        "address.list",
        "cart.get",
        "notifications.activities",
        "notifications.list",
        "orders.count",
        "orders.detail",
        "orders.list",
        "voucher.list",
        "voucher.meta",
        "wallet.overview",
        "wallet.transactions",
      ].sort(),
    );
  });

  it("exports the locked doc set, contract test, and dispatcher module", () => {
    expect(API_DOC_NAMES).toEqual([
      "auth-login",
      "account",
      "orders",
      "cart",
      "address",
      "voucher",
      "notifications",
      "chat",
      "wallet",
      "exclusions",
    ]);
    expect(OPERATION_CONTRACT_TEST).toBe("tests/unit/coverage.test.ts");
    expect(DISPATCHER_MODULE).toBe("src/dispatcher/shopee-dispatcher.ts");
    expect(API_DOC_NAMES).not.toContain("hosts");
    expect(API_DOC_NAMES).not.toContain("architecture");
    expect(API_DOC_NAMES).not.toContain("overview");
    expect(API_DOC_NAMES).not.toContain("operations");
    expect(API_DOC_NAMES).not.toContain("security");
    expect(API_DOC_NAMES).not.toContain("setup");
  });

  it("every exposed op has documented-not-executed or observed evidence", () => {
    for (const op of listExposedOperations()) {
      expect(["documented-not-executed", "observed"], op.operationId).toContain(op.evidence);
    }
  });

  it("session-only login hops cite connect tests and the login-flow module", () => {
    expect(SESSION_ONLY).toHaveLength(4);
    for (const e of SESSION_ONLY) {
      expect(e.status).toBe("session-only");
      expect(e.testFile).toBe(SESSION_ONLY_TEST);
      expect(e.implModule).toBe(SESSION_ONLY_IMPL);
      expect(e.operationId).toBeNull();
      expect(fileExists(e.implModule!)).toBe(true);
      expect(fileExists(e.testFile!)).toBe(true);
    }
    expect(SESSION_ONLY.map((e) => `${e.method} ${e.path}`).sort()).toEqual(
      [
        "GET /buyer/login",
        "POST /api/v2/authentication/login",
        "POST /api/v2/authentication/resend_otp",
        "POST /api/v2/authentication/vcode_login",
      ].sort(),
    );
  });

  it("does not extract Worker Connect URLs, hosts.md, or architecture docs", () => {
    expect(parseDocUrl("mcp.shopee.badry.engineer/connect/paste")).toBeNull();
    expect(parseDocUrl("https://mcp.shopee.badry.engineer/connect/callback")).toBeNull();
    expect(docEndpoints.some((e) => e.path.includes("/connect"))).toBe(false);
    expect(docEndpoints.some((e) => e.sourceDocument === "hosts.md")).toBe(false);
    expect(docEndpoints.every((e) => e.host === "www")).toBe(true);
  });

  it("does not expose checkout/cancel writes; cart/update is excluded", () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(ids).not.toContain("orders.cancel");
    expect(ids).not.toContain("cart.add");
    expect(ids).not.toContain("cart.update");
    expect(EXCLUSIONS).toHaveLength(1);
    expect(EXCLUSIONS[0]).toMatchObject({
      method: "POST",
      path: "/api/v4/cart/update",
      status: "excluded",
    });
  });

  it("implemented entries cite the dispatcher and contract test", () => {
    const implemented = manifest.filter((x) => x.status === "implemented");
    expect(implemented).toHaveLength(12);
    for (const e of implemented) {
      expect(e.implModule).toBe(DISPATCHER_MODULE);
      expect(e.testFile).toBe(OPERATION_CONTRACT_TEST);
      expect(fileExists(e.implModule!)).toBe(true);
      expect(fileExists(e.testFile!)).toBe(true);
    }
  });

  it("committed coverage report matches the renderer", () => {
    const expected = renderCoverageMarkdown(manifest, coverageSummary());
    const actual = readFileSync(path.join(root, "docs", "architecture", "coverage.md"), "utf8");
    expect(actual).toBe(expected);
  });

  it("hostBaseUrl is https shopee.co.id without a merchant slug", () => {
    expect(hostBaseUrl("www")).toBe("https://shopee.co.id");
  });
});
