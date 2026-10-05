import { coverageKey } from "./coverage";
import type { DocEndpoint } from "./doc-endpoints";
import { hostBaseUrl } from "./openapi";
import type { ApiOperation, CoverageEntry } from "./types";

/**
 * Drift checks shared by tests/unit/coverage.test.ts, tests/unit/openapi.test.ts and the
 * `coverage:validate` / `openapi:validate` scripts. Each returns a list of problems
 * (empty = OK). Pure: file existence is injected so this never touches fs itself.
 */

const UNSUPPORTED_EVIDENCE: ReadonlySet<ApiOperation["evidence"]> = new Set([
  "failed-probe",
  "unknown",
]);

export function checkCoverage(input: {
  manifest: CoverageEntry[];
  operations: ApiOperation[];
  docEndpoints: DocEndpoint[];
  fileExists: (repoRelativePath: string) => boolean;
}): string[] {
  const problems: string[] = [];
  const { manifest, operations, docEndpoints, fileExists } = input;

  const docsByKey = new Map<string, Set<string>>();
  for (const e of docEndpoints) {
    const key = coverageKey(e);
    const docs = docsByKey.get(key) ?? new Set<string>();
    docs.add(e.sourceDocument);
    docsByKey.set(key, docs);
  }

  const manifestCounts = new Map<string, number>();
  for (const e of manifest) {
    const key = coverageKey(e);
    manifestCounts.set(key, (manifestCounts.get(key) ?? 0) + 1);
  }
  for (const [key, docs] of docsByKey) {
    const n = manifestCounts.get(key) ?? 0;
    if (n !== 1) {
      problems.push(`${key} (${[...docs].join(", ")}) has ${n} manifest entries, expected 1`);
    }
  }
  for (const [key, n] of manifestCounts) {
    if (n > 1 && !docsByKey.has(key)) problems.push(`${key} has ${n} manifest entries`);
  }

  const opIds = new Map<string, ApiOperation>();
  const opKeys = new Map<string, string>();
  for (const op of operations) {
    if (opIds.has(op.operationId)) problems.push(`duplicate operationId ${op.operationId}`);
    opIds.set(op.operationId, op);
    const key = coverageKey({ method: op.method, host: op.host, path: op.pathTemplate });
    const prior = opKeys.get(key);
    if (prior) problems.push(`${key} registered twice (${prior}, ${op.operationId})`);
    opKeys.set(key, op.operationId);
    if (op.exposed && UNSUPPORTED_EVIDENCE.has(op.evidence)) {
      problems.push(`${op.operationId} is exposed with ${op.evidence} evidence`);
    }
  }

  for (const e of manifest) {
    const key = coverageKey(e);
    const docs = docsByKey.get(key);
    if (!docs) problems.push(`${key} is in the manifest but not documented in docs/*.md`);
    else if (!docs.has(e.sourceDocument)) {
      problems.push(`${key} cites ${e.sourceDocument}, documented in ${[...docs].join(", ")}`);
    }

    const opBacked = e.status === "implemented" || e.status === "html-adapter" || e.status === "mutation-gated";
    if (opBacked) {
      const op = e.operationId ? opIds.get(e.operationId) : undefined;
      if (!op || !op.exposed) {
        problems.push(`${key} is ${e.status} but operationId ${e.operationId} is not an exposed op`);
      } else if (coverageKey({ method: op.method, host: op.host, path: op.pathTemplate }) !== key) {
        problems.push(`${key} does not match ${op.operationId} method/host/path`);
      } else if ((op.safety === "read") !== (e.status !== "mutation-gated")) {
        problems.push(`${op.operationId} safety ${op.safety} disagrees with status ${e.status}`);
      }
    } else {
      if (e.operationId !== null) problems.push(`${key} is ${e.status} but has operationId`);
      if (!e.exclusionReason) problems.push(`${key} is ${e.status} without a reason`);
      if (opKeys.has(key)) problems.push(`${key} is ${e.status} but registered as ${opKeys.get(key)}`);
    }
    if (e.status === "excluded" && (e.implModule !== null || e.testFile !== null)) {
      problems.push(`${key} is excluded but names implModule/testFile`);
    }
    if (e.status === "session-only" && (!e.implModule || !e.testFile)) {
      problems.push(`${key} is session-only without implModule/testFile`);
    }
    for (const file of [e.implModule, e.testFile]) {
      if (file !== null && !fileExists(file)) problems.push(`${key} references missing file ${file}`);
    }
  }
  return problems;
}

interface OpenApiOperation {
  operationId?: string;
  servers?: Array<{ url?: string }>;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
}

export function checkOpenApi(input: {
  document: Record<string, unknown>;
  operations: ApiOperation[];
}): string[] {
  const problems: string[] = [];
  const { document, operations } = input;
  if (document.openapi !== "3.1.0") problems.push("openapi must be 3.1.0");
  const paths = (document.paths ?? {}) as Record<string, Record<string, OpenApiOperation>>;

  const exposed = operations.filter((o) => o.exposed);
  let documented = 0;
  for (const item of Object.values(paths)) documented += Object.keys(item).length;
  if (documented !== exposed.length) {
    problems.push(`OpenAPI has ${documented} operations, registry exposes ${exposed.length}`);
  }

  for (const op of exposed) {
    const entry = paths[op.pathTemplate]?.[op.method.toLowerCase()];
    if (!entry) {
      problems.push(`${op.operationId}: missing ${op.method} ${op.pathTemplate}`);
      continue;
    }
    if (entry.operationId !== op.operationId) {
      problems.push(`${op.method} ${op.pathTemplate} is ${entry.operationId}, expected ${op.operationId}`);
    }
    const servers = entry.servers ?? [];
    const expectedUrl = hostBaseUrl(op.host);
    if (servers.length !== 1 || servers[0]?.url !== expectedUrl) {
      problems.push(`${op.operationId}: servers must be exactly [${expectedUrl}]`);
    }
    for (const name of op.pathTemplate.match(/\{([^}]+)\}/g) ?? []) {
      const bare = name.slice(1, -1);
      const param = entry.parameters?.find((p) => p.name === bare);
      if (param?.in !== "path" || param.required !== true) {
        problems.push(`${op.operationId}: path param ${bare} not declared as required in:path`);
      }
    }
  }

  const raw = JSON.stringify(document);
  if (
    /Bearer [A-Za-z0-9_-]{16,}/.test(raw) ||
    /partner_key=|access_token=|refresh_token=|&sign=/i.test(raw)
  ) {
    problems.push("OpenAPI appears to contain credentials");
  }
  if (/"(example|examples|default)":/.test(raw)) {
    problems.push("OpenAPI must not carry example/default values copied from captures");
  }
  return problems;
}
