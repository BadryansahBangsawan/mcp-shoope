/**
 * Thin wrapper over checkCoverage (also run by tests/unit/coverage.test.ts).
 * Exits non-zero when any documented endpoint lacks exactly one manifest entry.
 * `--write-report` also regenerates docs/architecture/coverage.md from the manifest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkCoverage } from "../src/registry/checks";
import { buildCoverageManifest, coverageSummary } from "../src/registry/coverage";
import { renderCoverageMarkdown } from "../src/registry/coverage-report";
import { API_DOC_NAMES, extractDocEndpoints } from "../src/registry/doc-endpoints";
import { OPERATIONS } from "../src/registry/operations";

const root = path.resolve(import.meta.dirname, "..");
const docs = Object.fromEntries(
  API_DOC_NAMES.map((n) => [`${n}.md`, readFileSync(path.join(root, "docs", `${n}.md`), "utf8")]),
);
const docEndpoints = extractDocEndpoints(docs);
const problems = checkCoverage({
  manifest: buildCoverageManifest(),
  operations: OPERATIONS,
  docEndpoints,
  fileExists: (p) => existsSync(path.join(root, p)),
});
if (problems.length) {
  console.error(`Coverage validation failed (${problems.length}):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
const summary = coverageSummary();
if (process.argv.includes("--write-report")) {
  const report = renderCoverageMarkdown(buildCoverageManifest(), summary);
  writeFileSync(path.join(root, "docs", "architecture", "coverage.md"), report);
}
const documentedEndpoints = new Set(docEndpoints.map((e) => `${e.method} ${e.host} ${e.path}`)).size;
console.log(JSON.stringify({ ok: true, summary, documentedEndpoints }, null, 2));
