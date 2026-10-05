/**
 * Thin wrapper over checkOpenApi (also run by tests/unit/openapi.test.ts).
 * Exits non-zero on operationId/path drift, missing per-operation host servers,
 * undeclared path params, or credential-like content.
 */
import { checkOpenApi } from "../src/registry/checks";
import { buildOpenApiDocument } from "../src/registry/openapi";
import { OPERATIONS } from "../src/registry/operations";

let problems: string[];
let paths = 0;
try {
  const document = buildOpenApiDocument();
  paths = Object.keys((document.paths ?? {}) as object).length;
  problems = checkOpenApi({ document, operations: OPERATIONS });
} catch (err) {
  problems = [err instanceof Error ? err.message : String(err)];
}
if (problems.length) {
  console.error(`OpenAPI validation failed (${problems.length}):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, paths, operations: OPERATIONS.filter((o) => o.exposed).length }));
