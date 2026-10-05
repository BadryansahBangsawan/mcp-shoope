import { describe, expect, it } from "vitest";
import { checkOpenApi } from "../../src/registry/checks";
import { buildOpenApiDocument, hostBaseUrl } from "../../src/registry/openapi";
import { OPERATIONS, listExposedOperations } from "../../src/registry/operations";
import type { ApiOperation } from "../../src/registry/types";

interface OpenApiOp {
  operationId: string;
  servers?: Array<{ url: string; description?: string }>;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
}

type Paths = Record<string, Record<string, OpenApiOp>>;

function build(operations?: ApiOperation[]): { doc: Record<string, unknown>; paths: Paths } {
  const doc = buildOpenApiDocument(operations);
  return { doc, paths: doc.paths as Paths };
}

const CREDENTIAL_ASSIGN = /partner_key=|access_token=|refresh_token=|&sign=/i;

const dummy: ApiOperation = {
  operationId: "dummy.a",
  method: "GET",
  host: "www",
  pathTemplate: "/x",
  title: "a",
  description: "a",
  sourceDocument: "account.md",
  evidence: "observed",
  authProfile: "cookie-csrf",
  responseKind: "json",
  safety: "read",
  tags: [],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  exposed: true,
};

describe("OpenAPI document", () => {
  it("passes the shared drift checks", () => {
    const { doc } = build();
    expect(listExposedOperations().length).toBe(OPERATIONS.filter((o) => o.exposed).length);
    expect(checkOpenApi({ document: doc, operations: OPERATIONS })).toEqual([]);
  });

  it("binds every operation to exactly one www server", () => {
    const { doc, paths } = build();
    expect(doc.servers).toBeUndefined();
    expect(hostBaseUrl("www")).toBe("https://shopee.co.id");
    expect((doc.info as { title?: string }).title).toBe("Shopee buyer account (sanitized)");
    for (const op of listExposedOperations()) {
      const entry = paths[op.pathTemplate]?.[op.method.toLowerCase()];
      expect(entry?.operationId).toBe(op.operationId);
      expect(entry?.servers, op.operationId).toEqual([
        { url: hostBaseUrl(op.host), description: op.host },
      ]);
    }
  });

  it("throws instead of silently overwriting a path collision", () => {
    const collide: ApiOperation = { ...dummy, operationId: "dummy.b" };
    expect(() => buildOpenApiDocument([dummy, collide])).toThrow(/OpenAPI path collision/);
  });

  it("does not carry example/default or credential-like strings", () => {
    const raw = JSON.stringify(build().doc);
    expect(raw).not.toMatch(/"(example|examples|default)":/);
    expect(raw).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);
    expect(raw).not.toMatch(CREDENTIAL_ASSIGN);
  });

  it("security scheme cookieCsrf / x-csrftoken does not trip the credential regex", () => {
    const { doc } = build();
    const raw = JSON.stringify(doc);
    expect(raw).toMatch(/"name":"x-csrftoken"/);
    expect(raw).toMatch(/"cookieCsrf"/);
    expect(raw).not.toMatch(/&sign=/i);
    expect(checkOpenApi({ document: doc, operations: OPERATIONS })).toEqual([]);

    const withQuery = structuredClone(doc) as {
      info?: { description?: string };
    };
    withQuery.info = {
      ...(typeof doc.info === "object" && doc.info ? doc.info : {}),
      description: "https://shopee.co.id/x?foo=1&sign=deadbeefcafebabe",
    };
    expect(checkOpenApi({ document: withQuery, operations: OPERATIONS })).toContain(
      "OpenAPI appears to contain credentials",
    );

    const withAssign = structuredClone(doc) as { info?: { description?: string } };
    withAssign.info = {
      ...(typeof doc.info === "object" && doc.info ? doc.info : {}),
      description: "partner_key=abc access_token=def refresh_token=ghi",
    };
    expect(checkOpenApi({ document: withAssign, operations: OPERATIONS })).toContain(
      "OpenAPI appears to contain credentials",
    );
  });

  it("v1 GET ops have no path parameters", () => {
    const { paths } = build();
    for (const op of listExposedOperations()) {
      const entry = paths[op.pathTemplate]?.[op.method.toLowerCase()];
      expect(entry?.parameters?.some((p) => p.in === "path"), op.operationId).toBeFalsy();
    }
  });
});
