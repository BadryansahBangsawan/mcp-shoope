import type { ApiOperation, JsonSchemaLike } from "../types";

export function op(partial: ApiOperation): ApiOperation {
  return partial;
}

export const emptyQuery: JsonSchemaLike = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const closedObject = (
  properties: Record<string, JsonSchemaLike>,
  required: string[] = [],
): JsonSchemaLike => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** Defaults for captured buyer JSON reads. */
export const cookieJson = {
  authProfile: "cookie-csrf" as const,
  responseKind: "json" as const,
  safety: "read" as const,
  evidence: "observed" as const,
  exposed: true,
  host: "www" as const,
  method: "GET" as const,
};
