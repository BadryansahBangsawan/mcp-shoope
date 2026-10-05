import { HOSTS } from "../dispatcher/allowlist";
import { listExposedOperations } from "./operations";
import type { ApiOperation, HostKey, JsonSchemaLike } from "./types";
import { isQueryIn, pathParamNames } from "./validate";

/** Base URL for one host (no merchant slug; single-tenant). */
export function hostBaseUrl(host: HostKey): string {
  return `https://${HOSTS[host]}`;
}

/**
 * Sanitized OpenAPI 3.1 document for Code Mode search (no secrets/PII samples).
 * Each operation carries its own single `servers` entry. OpenAPI paths are keyed
 * without the host, so two ops sharing method+path cannot both be represented.
 */
export function buildOpenApiDocument(
  operations: ApiOperation[] = listExposedOperations(),
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const pathKey = op.pathTemplate;
    const method = op.method.toLowerCase();
    const item = paths[pathKey] ?? {};
    const existing = item[method] as { operationId?: string } | undefined;
    if (existing) {
      throw new Error(
        `OpenAPI path collision: ${op.method} ${pathKey} used by ${existing.operationId} and ${op.operationId}`,
      );
    }
    item[method] = operationToOpenApi(op);
    paths[pathKey] = item;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Shopee buyer account (sanitized)",
      version: "0.1.0",
      description:
        "Generated from shopee-mcp operation registry. Host is shopee.co.id. Cookie and CSRF headers are injected by the dispatcher. The model never chooses method, URL, or headers.",
    },
    tags: uniqueTags(operations).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        cookieCsrf: {
          type: "apiKey",
          in: "header",
          name: "x-csrftoken",
          description:
            "CSRF token from the csrftoken cookie, injected as header x-csrftoken. The model never chooses Cookie or CSRF headers.",
        },
      },
    },
  };
}

function operationToOpenApi(op: ApiOperation): Record<string, unknown> {
  return {
    operationId: op.operationId,
    summary: op.title,
    description: op.description,
    tags: op.tags,
    servers: [{ url: hostBaseUrl(op.host), description: op.host }],
    "x-shopee-host": op.host,
    "x-shopee-auth": op.authProfile,
    "x-shopee-safety": op.safety,
    "x-shopee-evidence": op.evidence,
    "x-shopee-response-kind": op.responseKind,
    "x-shopee-source": op.sourceDocument,
    requestBody:
      op.method === "GET" || op.method === "DELETE"
        ? undefined
        : {
            required: true,
            content: {
              "application/json": { schema: bodyInputSchema(op) },
            },
          },
    parameters:
      op.method === "GET" || op.method === "DELETE"
        ? schemaToParameters(op)
        : [...pathParamsOnly(op), ...queryParamsOnly(op)],
    responses: {
      "200": {
        description: "Success",
        content: {
          [op.responseKind === "html" ? "text/html" : "application/json"]: {
            schema: op.outputSchema ?? { type: "object" },
          },
        },
      },
    },
  };
}

function schemaToParameters(op: ApiOperation): unknown[] {
  const props = op.inputSchema.properties ?? {};
  const required = new Set(op.inputSchema.required ?? []);
  const params: unknown[] = [];
  for (const [name, schema] of Object.entries(props)) {
    const inPath = op.pathTemplate.includes(`{${name}}`);
    params.push({
      name,
      in: inPath ? "path" : "query",
      required: inPath || required.has(name),
      schema: publicSchema(schema),
    });
  }
  return params;
}

function pathParamsOnly(op: ApiOperation): unknown[] {
  const props = op.inputSchema.properties ?? {};
  return Object.entries(props)
    .filter(([name]) => op.pathTemplate.includes(`{${name}}`))
    .map(([name, schema]) => ({
      name,
      in: "path",
      required: true,
      schema: publicSchema(schema),
    }));
}

function queryParamsOnly(op: ApiOperation): unknown[] {
  const props = op.inputSchema.properties ?? {};
  const required = new Set(op.inputSchema.required ?? []);
  return Object.entries(props)
    .filter(([, schema]) => isQueryIn(schema))
    .map(([name, schema]) => ({
      name,
      in: "query",
      required: required.has(name),
      schema: publicSchema(schema),
    }));
}

function bodyInputSchema(op: ApiOperation): JsonSchemaLike {
  const pathNames = new Set(pathParamNames(op.pathTemplate));
  const props = op.inputSchema.properties ?? {};
  const properties: Record<string, JsonSchemaLike> = {};
  for (const [name, schema] of Object.entries(props)) {
    if (pathNames.has(name) || isQueryIn(schema)) continue;
    properties[name] = publicSchema(schema);
  }
  const required = (op.inputSchema.required ?? []).filter((n) => n in properties);
  return {
    type: "object",
    properties,
    additionalProperties: op.inputSchema.additionalProperties ?? false,
    ...(required.length ? { required } : {}),
  };
}

function publicSchema(schema: JsonSchemaLike): JsonSchemaLike {
  const { "x-in": _omit, ...rest } = schema;
  const out: JsonSchemaLike = { ...rest };
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, publicSchema(v)]),
    );
  }
  if (out.items) out.items = publicSchema(out.items);
  return out;
}

function uniqueTags(ops: ApiOperation[]): string[] {
  return [...new Set(ops.flatMap((o) => o.tags))].sort();
}

/** Compact catalog for search without full schemas. */
export function buildOperationCatalog(): Array<Record<string, unknown>> {
  return listExposedOperations().map((o) => ({
    operationId: o.operationId,
    title: o.title,
    description: o.description,
    method: o.method,
    host: o.host,
    path: o.pathTemplate,
    safety: o.safety,
    auth: o.authProfile,
    responseKind: o.responseKind,
    tags: o.tags,
    evidence: o.evidence,
    sourceDocument: o.sourceDocument,
    inputKeys: Object.keys(o.inputSchema.properties ?? {}),
  }));
}
