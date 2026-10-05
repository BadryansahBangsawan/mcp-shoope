import { EXCLUSIONS, SESSION_ONLY } from "./exclusions";
import { OPERATIONS } from "./operations";
import type { ApiOperation, CoverageEntry } from "./types";

/**
 * Registry/OpenAPI contract test that runs a per-operation block for every
 * operationId (schema, host binding, OpenAPI entry, coverage status).
 */
export const OPERATION_CONTRACT_TEST = "tests/unit/coverage.test.ts";

export const DISPATCHER_MODULE = "src/dispatcher/shopee-dispatcher.ts";

function operationEntry(o: ApiOperation): CoverageEntry {
  if (o.responseKind === "html") {
    throw new Error(`HTML operation ${o.operationId} has no adapter in v1`);
  }
  return {
    sourceDocument: o.sourceDocument,
    method: o.method,
    host: o.host,
    path: o.pathTemplate,
    operationId: o.operationId,
    auth: o.authProfile,
    safety: o.safety,
    implModule: DISPATCHER_MODULE,
    testFile: OPERATION_CONTRACT_TEST,
    status: o.safety !== "read" ? "mutation-gated" : "implemented",
  };
}

/** Machine-readable coverage: every documented method+host+path appears exactly once. */
export function buildCoverageManifest(): CoverageEntry[] {
  return [
    ...OPERATIONS.filter((o) => o.exposed).map(operationEntry),
    ...SESSION_ONLY,
    ...EXCLUSIONS,
  ];
}

/** Stable manifest key; template parameter names are ignored so `{id}` == `{classId}`. */
export function coverageKey(e: { method: string; host: string; path: string }): string {
  return `${e.method.toUpperCase()} ${e.host} ${e.path.replace(/\{[^}]*\}/g, "{}")}`;
}

export function coverageSummary(): {
  total: number;
  implemented: number;
  htmlAdapter: number;
  mutationGated: number;
  sessionOnly: number;
  excluded: number;
} {
  const m = buildCoverageManifest();
  const count = (s: CoverageEntry["status"]) => m.filter((e) => e.status === s).length;
  return {
    total: m.length,
    implemented: count("implemented"),
    htmlAdapter: count("html-adapter"),
    mutationGated: count("mutation-gated"),
    sessionOnly: count("session-only"),
    excluded: count("excluded"),
  };
}
