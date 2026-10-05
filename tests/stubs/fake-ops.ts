import type { ApiOperation, JsonSchemaLike } from "../../src/registry/types";

function closed(
  properties: Record<string, JsonSchemaLike> = {},
  required: string[] = [],
): JsonSchemaLike {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

const base = {
  host: "www" as const,
  authProfile: "cookie-csrf" as const,
  responseKind: "json" as const,
  evidence: "observed" as const,
  exposed: true,
  tags: ["test"],
};

/**
 * Overlay for `getOperation` in tests. Paths live only here so dispatcher
 * tests do not depend on capture path strings. `listExposedOperations` is
 * the real catalog.
 */
export const FAKE_OPS: Record<string, ApiOperation> = {
  "account.profile": {
    ...base,
    operationId: "account.profile",
    title: "Profil",
    description: "test",
    method: "GET",
    pathTemplate: "/api/v4/account/profile",
    safety: "read",
    sourceDocument: "account.md",
    inputSchema: closed(),
  },
  "cart.get": {
    ...base,
    operationId: "cart.get",
    title: "Keranjang",
    description: "test",
    method: "POST",
    pathTemplate: "/api/v4/cart/get",
    safety: "read",
    sourceDocument: "cart.md",
    inputSchema: closed(),
  },
  "cart.add": {
    ...base,
    operationId: "cart.add",
    title: "Tambah keranjang",
    description: "test",
    method: "POST",
    pathTemplate: "/api/v4/cart/add",
    safety: "write",
    sourceDocument: "cart.md",
    inputSchema: closed(),
  },
};
