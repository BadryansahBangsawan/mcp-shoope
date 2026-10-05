import { AppError, ErrorCodes } from "../errors/codes";
import type { ApiOperation, JsonSchemaLike } from "./types";

/** Raw caller input for one operation (model code, tools, scripts). */
export interface OperationInput {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

/** Input after schema validation and coercion; safe to put on the wire. */
export interface ValidatedInput {
  path: Record<string, string | number>;
  query: Record<string, string | number | boolean>;
  body?: unknown;
}

type Primitive = string | number | boolean;
type Mode = "path" | "query" | "body";

const PATH_PARAM = /\{([a-zA-Z0-9_]+)\}/g;
const INTEGER_PATH_SEGMENT = /^\d{1,20}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const INTEGER_STRING = /^-?\d{1,20}$/;
const NUMBER_STRING = /^-?\d{1,20}(\.\d{1,20})?$/;
/** Page-size style fields get an upper bound even when the docs give none. */
const PAGE_SIZE_KEYS = new Set(["count", "limit", "per_page", "page_size"]);
const DEFAULT_PAGE_SIZE_MAX = 100;
/** 1-based paging fields; 0 or negatives are never meaningful upstream. */
const PAGING_KEYS = new Set(["page", ...PAGE_SIZE_KEYS]);
/** Keeps model-built URLs bounded when the schema sets no maxLength. */
const DEFAULT_WIRE_STRING_MAX = 2000;

interface Problems {
  missing: string[];
  unknown: string[];
  invalid: string[];
}

/** Names of `{param}` placeholders in an operation path template, in order. */
export function pathParamNames(template: string): string[] {
  return [...template.matchAll(PATH_PARAM)].map((m) => m[1]!);
}

export function isQueryIn(prop: JsonSchemaLike | undefined): boolean {
  return prop?.["x-in"] === "query";
}

/**
 * Validate and coerce caller input against `op.inputSchema` (the doc-derived
 * subset in JsonSchemaLike). Path params come from the template; for GET/DELETE
 * every other declared property is a query param; for body methods a property
 * is query only when marked `x-in: query`, otherwise it is a body field.
 * Throws INVALID_INPUT listing every missing, unknown and mistyped key so
 * model code can fix all of them in one retry.
 */
export function validateOperationInput(
  op: ApiOperation,
  input: OperationInput,
): ValidatedInput {
  const problems: Problems = { missing: [], unknown: [], invalid: [] };
  const schema = op.inputSchema;
  const props = schema.properties ?? {};
  const closed = schema.additionalProperties === false;
  const pathNames = pathParamNames(op.pathTemplate);
  const pathSet = new Set(pathNames);
  const usesBody = op.method !== "GET" && op.method !== "DELETE";

  const rawPath: Record<string, unknown> = {};
  for (const [key, value] of entriesOf(input.path, "path", problems)) {
    if (!pathSet.has(key)) problems.unknown.push(`path.${key}`);
    else rawPath[key] = value;
  }

  const rawQuery: Record<string, unknown> = {};
  for (const [key, value] of entriesOf(input.query, "query", problems)) {
    if (pathSet.has(key)) {
      // Tolerate path params passed in query, but never two different values.
      if (key in rawPath && String(rawPath[key]) !== String(value)) {
        problems.invalid.push(`${key}: given in both path and query with different values`);
      } else {
        rawPath[key] = value;
      }
    } else if (usesBody && !isQueryIn(props[key])) {
      problems.unknown.push(`query.${key}`);
    } else {
      rawQuery[key] = value;
    }
  }

  const path: Record<string, string | number> = {};
  for (const name of pathNames) {
    if (!(name in rawPath)) {
      problems.missing.push(name);
      continue;
    }
    const value = checkPathParam(name, rawPath[name], props[name], problems);
    if (value !== undefined) path[name] = value;
  }

  const query: Record<string, Primitive> = {};
  const locatedBody = usesBody
    ? takeQueryAndPathFromBody(input.body, pathSet, props, rawQuery, problems)
    : input.body;
  const body = usesBody
    ? checkBody(locatedBody, bodyOnlySchema(schema, pathSet), problems)
    : rejectBody(input.body, problems);

  for (const [key, value] of Object.entries(rawQuery)) {
    const prop = props[key];
    if (!prop && closed) {
      problems.unknown.push(key);
      continue;
    }
    const coerced = checkValue(value, prop ?? {}, key, "query", problems);
    if (coerced !== undefined) query[key] = coerced as Primitive;
  }
  if (!usesBody) {
    for (const name of schema.required ?? []) {
      if (!pathSet.has(name) && !(name in rawQuery)) problems.missing.push(name);
    }
  }

  if (problems.missing.length || problems.unknown.length || problems.invalid.length) {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      describeProblems(op, problems, Object.keys(props)),
      { details: problems },
    );
  }
  return body === undefined ? { path, query } : { path, query, body };
}

function entriesOf(
  bag: unknown,
  label: "path" | "query",
  problems: Problems,
): Array<[string, unknown]> {
  if (bag === undefined || bag === null) return [];
  if (typeof bag !== "object" || Array.isArray(bag)) {
    problems.invalid.push(`${label}: expected an object of key/value pairs`);
    return [];
  }
  // undefined / null mean "not provided" (JSON drops undefined anyway).
  return Object.entries(bag as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && v !== null,
  );
}

function checkPathParam(
  name: string,
  raw: unknown,
  prop: JsonSchemaLike | undefined,
  problems: Problems,
): string | number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") {
    problems.invalid.push(`${name}: path params must be a string or number`);
    return undefined;
  }
  const text = typeof raw === "number" ? numberToPathText(raw) : raw;
  if (typeIncludes(prop, "integer")) {
    if (text === null || !INTEGER_PATH_SEGMENT.test(text)) {
      problems.invalid.push(`${name}: expected a non-negative integer id`);
      return undefined;
    }
    const n = Number(text);
    const value = Number.isSafeInteger(n) && String(n) === text ? n : text;
    return checkBounds(value, prop ?? {}, name, problems) ? value : undefined;
  }
  if (text === null || !SAFE_PATH_SEGMENT.test(text)) {
    problems.invalid.push(`${name}: path params may only contain A-Z a-z 0-9 _ - (max 64)`);
    return undefined;
  }
  return checkEnum(text, prop ?? {}, name, problems) ? text : undefined;
}

function numberToPathText(n: number): string | null {
  return Number.isSafeInteger(n) ? String(n) : null;
}

function rejectBody(body: unknown, problems: Problems): undefined {
  if (body !== undefined && body !== null) {
    problems.unknown.push("body (this operation takes path/query params only)");
  }
  return undefined;
}

function takeQueryAndPathFromBody(
  body: unknown,
  pathSet: Set<string>,
  props: Record<string, JsonSchemaLike>,
  rawQuery: Record<string, unknown>,
  problems: Problems,
): unknown {
  if (body === undefined || body === null || !isPlainObject(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (pathSet.has(key)) continue;
    if (isQueryIn(props[key])) {
      if (key in rawQuery && String(rawQuery[key]) !== String(value)) {
        problems.invalid.push(`${key}: given in both query and body with different values`);
      } else {
        rawQuery[key] = value;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function bodyOnlySchema(schema: JsonSchemaLike, pathSet: Set<string>): JsonSchemaLike {
  const props = schema.properties ?? {};
  const properties: Record<string, JsonSchemaLike> = {};
  for (const [name, prop] of Object.entries(props)) {
    if (pathSet.has(name) || isQueryIn(prop)) continue;
    properties[name] = prop;
  }
  const required = (schema.required ?? []).filter((n) => n in properties);
  return {
    type: "object",
    properties,
    additionalProperties: schema.additionalProperties,
    ...(required.length ? { required } : {}),
  };
}

function checkBody(body: unknown, schema: JsonSchemaLike, problems: Problems): unknown {
  const bodyRequired = schema.required ?? [];
  if (body === undefined || body === null) {
    for (const name of bodyRequired) problems.missing.push(`body.${name}`);
    return undefined;
  }
  return checkValue(body, schema, "body", "body", problems);
}

/**
 * Check one value against a schema node, coercing where the wire format is
 * lossless (numeric strings for integer/number, numbers for string fields,
 * "true"/"false" for booleans). Returns undefined when a problem was recorded.
 */
function checkValue(
  value: unknown,
  schema: JsonSchemaLike,
  at: string,
  mode: Mode,
  problems: Problems,
): unknown {
  const types = typeList(schema);
  if (mode !== "body" && !isPrimitive(value)) {
    problems.invalid.push(`${at}: query values must be strings, numbers or booleans`);
    return undefined;
  }
  if (types.length === 0) {
    const ok = checkBounds(value, schema, at, problems) && checkEnum(value, schema, at, problems);
    return ok ? value : undefined;
  }
  for (const type of types) {
    const coerced = coerce(value, type, schema, at, mode, problems);
    if (coerced.ok) {
      if (coerced.value === undefined) return undefined; // nested problem recorded
      if (!checkBounds(coerced.value, schema, at, problems)) return undefined;
      if (!checkEnum(coerced.value, schema, at, problems)) return undefined;
      return coerced.value;
    }
  }
  problems.invalid.push(`${at}: expected ${types.join(" | ")}, got ${describeType(value)}`);
  return undefined;
}

type Coerced = { ok: true; value: unknown } | { ok: false };

function coerce(
  value: unknown,
  type: string,
  schema: JsonSchemaLike,
  at: string,
  mode: Mode,
  problems: Problems,
): Coerced {
  switch (type) {
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return { ok: true, value };
      if (typeof value === "string" && INTEGER_STRING.test(value)) {
        const n = Number(value);
        if (Number.isSafeInteger(n)) return { ok: true, value: n };
      }
      return { ok: false };
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      if (typeof value === "string" && NUMBER_STRING.test(value)) {
        return { ok: true, value: Number(value) };
      }
      return { ok: false };
    case "string":
      if (typeof value === "string") return { ok: true, value };
      if (typeof value === "number" && Number.isFinite(value)) {
        return { ok: true, value: String(value) };
      }
      return { ok: false };
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true" || value === "false") return { ok: true, value: value === "true" };
      return { ok: false };
    case "null":
      return value === null ? { ok: true, value } : { ok: false };
    case "array":
      if (mode !== "body" || !Array.isArray(value)) return { ok: false };
      return { ok: true, value: checkArray(value, schema, at, problems) };
    case "object":
      if (mode !== "body" || !isPlainObject(value)) return { ok: false };
      return { ok: true, value: checkObject(value, schema, at, problems) };
    default:
      return { ok: false };
  }
}

function checkArray(
  value: unknown[],
  schema: JsonSchemaLike,
  at: string,
  problems: Problems,
): unknown[] | undefined {
  const before = problems.invalid.length + problems.missing.length + problems.unknown.length;
  const items = schema.items;
  const out = items
    ? value.map((item, i) => checkValue(item, items, `${at}[${i}]`, "body", problems))
    : value;
  const after = problems.invalid.length + problems.missing.length + problems.unknown.length;
  return after === before ? out : undefined;
}

function checkObject(
  value: Record<string, unknown>,
  schema: JsonSchemaLike,
  at: string,
  problems: Problems,
): Record<string, unknown> | undefined {
  const before = problems.invalid.length + problems.missing.length + problems.unknown.length;
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) problems.unknown.push(`${at}.${key}`);
      else out[key] = child;
      continue;
    }
    out[key] = checkValue(child, prop, `${at}.${key}`, "body", problems);
  }
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) problems.missing.push(`${at}.${name}`);
  }
  const after = problems.invalid.length + problems.missing.length + problems.unknown.length;
  return after === before ? out : undefined;
}

function checkBounds(
  value: unknown,
  schema: JsonSchemaLike,
  at: string,
  problems: Problems,
): boolean {
  const key = at.slice(at.lastIndexOf(".") + 1);
  if (typeof value === "number") {
    const isInteger = typeIncludes(schema, "integer");
    const min =
      numberOr(schema.minimum) ?? (isInteger && PAGING_KEYS.has(key) ? 1 : undefined);
    const max =
      numberOr(schema.maximum) ??
      (isInteger && PAGE_SIZE_KEYS.has(key) ? DEFAULT_PAGE_SIZE_MAX : undefined);
    if (min !== undefined && value < min) {
      problems.invalid.push(`${at}: must be >= ${min}`);
      return false;
    }
    if (max !== undefined && value > max) {
      problems.invalid.push(`${at}: must be <= ${max}`);
      return false;
    }
  }
  if (typeof value === "string") {
    const maxLength = numberOr(schema.maxLength) ?? DEFAULT_WIRE_STRING_MAX;
    if (value.length > maxLength) {
      problems.invalid.push(`${at}: longer than ${maxLength} characters`);
      return false;
    }
  }
  return true;
}

function checkEnum(
  value: unknown,
  schema: JsonSchemaLike,
  at: string,
  problems: Problems,
): boolean {
  if (!Array.isArray(schema.enum) || schema.enum.includes(value)) return true;
  problems.invalid.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  return false;
}

function describeProblems(op: ApiOperation, problems: Problems, allowed: string[]): string {
  const parts: string[] = [];
  if (problems.missing.length) parts.push(`missing required: ${problems.missing.join(", ")}`);
  if (problems.unknown.length) {
    parts.push(
      `unknown: ${problems.unknown.join(", ")} (allowed: ${allowed.length ? allowed.join(", ") : "none"})`,
    );
  }
  if (problems.invalid.length) parts.push(`invalid: ${problems.invalid.join("; ")}`);
  return `Invalid input for ${op.operationId}: ${parts.join("; ")}`;
}

function typeList(schema: JsonSchemaLike | undefined): string[] {
  if (!schema?.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function typeIncludes(schema: JsonSchemaLike | undefined, type: string): boolean {
  return typeList(schema).includes(type);
}

function numberOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isPrimitive(v: unknown): v is Primitive {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
