import { describe, expect, it } from "vitest";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import { OPERATIONS } from "../../src/registry/operations";
import type { ApiOperation } from "../../src/registry/types";
import {
  pathParamNames,
  validateOperationInput,
  type OperationInput,
} from "../../src/registry/validate";

function syntheticOp(overrides: Partial<ApiOperation> = {}): ApiOperation {
  return {
    operationId: "synthetic.read",
    title: "t",
    description: "d",
    method: "GET",
    host: "www",
    pathTemplate: "/api/v4/x",
    sourceDocument: "account.md",
    evidence: "observed",
    authProfile: "cookie-csrf",
    responseKind: "json",
    safety: "read",
    tags: [],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    exposed: true,
    ...overrides,
  };
}

function invalid(op: ApiOperation, input: OperationInput): AppError {
  try {
    validateOperationInput(op, input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCodes.INVALID_INPUT);
    return err as AppError;
  }
  throw new Error(`expected INVALID_INPUT for ${op.operationId}`);
}

describe("validateOperationInput — empty catalog + closed schemas", () => {
  it("v1 ops have no path templates with {} — pathParamNames is empty", () => {
    for (const o of OPERATIONS) {
      expect(pathParamNames(o.pathTemplate), o.operationId).toEqual([]);
      expect(o.pathTemplate).not.toMatch(/\{/);
    }
  });

  it("rejects extra query keys and a body on GET", () => {
    const op = syntheticOp();
    expect(validateOperationInput(op, {})).toEqual({ path: {}, query: {} });
    expect(invalid(op, { query: { cookie: "evil" } }).message).toContain("unknown: cookie");
    expect(invalid(op, { body: { x: 1 } }).message).toContain("unknown: body");
  });

  it("POST closed schema rejects extra body keys", () => {
    const op = syntheticOp({
      method: "POST",
      pathTemplate: "/api/v4/cart/get",
    });
    expect(validateOperationInput(op, { body: {} })).toEqual({ path: {}, query: {}, body: {} });
    expect(invalid(op, { body: { cookie: "evil" } }).message).toContain("unknown");
  });
});

describe("validateOperationInput — types, coercion and bounds", () => {
  const paged = syntheticOp({
    inputSchema: {
      type: "object",
      properties: {
        time_from: { type: "integer" },
        time_to: { type: "integer" },
        page_size: { type: "integer" },
        cursor: { type: "string" },
      },
      required: ["time_from", "time_to"],
      additionalProperties: false,
    },
  });

  it("requires declared fields and caps page_size at 100", () => {
    expect(invalid(paged, { query: { page_size: 10 } }).details).toMatchObject({
      missing: ["time_from", "time_to"],
    });
    expect(
      invalid(paged, {
        query: { time_from: 1_700_000_000, time_to: 1_700_000_100, page_size: 101 },
      }).message,
    ).toContain("page_size: must be <= 100");
    expect(
      validateOperationInput(paged, {
        query: { time_from: 1_700_000_000, time_to: 1_700_000_100, page_size: 100 },
      }).query,
    ).toEqual({ time_from: 1_700_000_000, time_to: 1_700_000_100, page_size: 100 });
  });

  it("coerces numeric strings for integer fields", () => {
    expect(
      validateOperationInput(paged, {
        query: {
          time_from: "1700000000" as unknown as number,
          time_to: "1700003600" as unknown as number,
          page_size: "20" as unknown as number,
        },
      }),
    ).toEqual({
      path: {},
      query: { time_from: 1_700_000_000, time_to: 1_700_003_600, page_size: 20 },
    });
  });

  it("rejects non-numeric integers, nested objects and arrays in query", () => {
    const err = invalid(paged, {
      query: {
        time_from: "one",
        time_to: { a: 1 } as unknown as number,
        cursor: ["x"] as unknown as string,
      },
    });
    expect(err.message).toContain("time_from: expected integer, got string");
    expect(err.message).toContain("time_to: query values must be strings, numbers or booleans");
    expect(err.message).toContain("cursor: query values must be strings, numbers or booleans");
  });

  it("defaults count|limit|page_size to maximum 100 when the schema has none", () => {
    const bare = syntheticOp({
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "integer" },
          count: { type: "integer" },
          limit: { type: "integer" },
          page_size: { type: "integer" },
          other: { type: "integer" },
        },
        additionalProperties: false,
      },
    });
    for (const key of ["count", "limit", "page_size"]) {
      expect(() => validateOperationInput(bare, { query: { [key]: 101 } })).toThrow(
        `${key}: must be <= 100`,
      );
    }
    expect(() => validateOperationInput(bare, { query: { page: 0 } })).toThrow("page: must be >= 1");
    expect(validateOperationInput(bare, { query: { other: 5000, page: 9999 } }).query).toEqual({
      other: 5000,
      page: 9999,
    });
  });

  it("honours schema minimum/maximum/enum when present", () => {
    const custom = syntheticOp({
      inputSchema: {
        type: "object",
        properties: {
          page_size: { type: "integer", maximum: 500 },
          sort: { type: "string", enum: ["asc", "desc"] },
          ratio: { type: "number", minimum: 0.5 },
        },
        additionalProperties: false,
      },
    });
    expect(validateOperationInput(custom, { query: { page_size: 400 } }).query).toEqual({
      page_size: 400,
    });
    expect(() => validateOperationInput(custom, { query: { page_size: 501 } })).toThrow("<= 500");
    expect(() => validateOperationInput(custom, { query: { sort: "up" } })).toThrow(
      'must be one of "asc", "desc"',
    );
    expect(() => validateOperationInput(custom, { query: { ratio: 0.1 } })).toThrow(">= 0.5");
  });

  it("drops undefined/null query values as not provided", () => {
    const out = validateOperationInput(paged, {
      query: {
        time_from: 1,
        time_to: 2,
        page_size: undefined as unknown as number,
      },
    });
    expect(out.query).toEqual({ time_from: 1, time_to: 2 });
  });

  it("rejects over-long strings", () => {
    const search = syntheticOp({
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        additionalProperties: false,
      },
    });
    const err = invalid(search, { query: { q: "x".repeat(2001) } });
    expect(err.message).toContain("longer than");
  });
});

describe("validateOperationInput — synthetic path params (v1 templates have none)", () => {
  const stringPath = syntheticOp({
    pathTemplate: "/api/v4/things/{id}",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  });

  it("string path params are restricted to a safe segment charset", () => {
    expect(pathParamNames(stringPath.pathTemplate)).toEqual(["id"]);
    for (const bad of [".", "..", "a.b", "a/b", "a%2Fb", "x".repeat(65), "a?b", "a\\b", ""]) {
      expect(() => validateOperationInput(stringPath, { path: { id: bad } })).toThrow(
        /id: path params may only contain/,
      );
    }
    expect(validateOperationInput(stringPath, { path: { id: "abc_12-3" } }).path).toEqual({
      id: "abc_12-3",
    });
  });
});
