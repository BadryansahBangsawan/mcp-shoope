import type { CoverageEntry } from "./types";

type Summary = Record<
  "total" | "implemented" | "htmlAdapter" | "mutationGated" | "sessionOnly" | "excluded",
  number
>;

const cell = (v: string | null | undefined) =>
  v ? v.replace(/\|/g, "\\|") : "—";
const code = (v: string | null | undefined) => (v ? `\`${v}\`` : "—");

const SAFETY_LABEL: Record<CoverageEntry["safety"], string> = {
  read: "R",
  write: "W",
  destructive: "W (destructive)",
  "n/a": "—",
};

/**
 * Renders docs/architecture/coverage.md from the manifest. Regenerate with
 * `bun run scripts/validate-coverage.ts --write-report`; tests/unit/coverage.test.ts
 * fails when the committed report drifts.
 */
export function renderCoverageMarkdown(entries: CoverageEntry[], summary: Summary): string {
  const sorted = [...entries].sort(
    (a, b) =>
      a.sourceDocument.localeCompare(b.sourceDocument) ||
      a.host.localeCompare(b.host) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );
  const rows = sorted.map((e) =>
    [
      `\`${e.sourceDocument}\``,
      `\`${e.method} ${e.host} ${e.path}\``,
      code(e.operationId),
      e.auth,
      SAFETY_LABEL[e.safety],
      code(e.implModule),
      code(e.testFile),
      e.status,
      cell(e.exclusionReason),
    ].join(" | "),
  );
  return [
    "# API coverage",
    "",
    "<!-- Generated from src/registry (operations + exclusions). Do not edit by hand: run `bun run scripts/validate-coverage.ts --write-report`. -->",
    "",
    "Every METHOD + host + path documented in the API docs under `docs/` has exactly one entry below.",
    "`tests/unit/coverage.test.ts` extracts the endpoints from the markdown and fails on any gap, duplicate,",
    "undocumented entry, exposed failed probe, or missing impl/test file.",
    "",
    "```bash",
    "bun run coverage:validate",
    "bun run openapi:validate",
    "```",
    "",
    "## Totals",
    "",
    "| Status | Count |",
    "| --- | --- |",
    `| implemented | ${summary.implemented} |`,
    `| html-adapter | ${summary.htmlAdapter} |`,
    `| mutation-gated | ${summary.mutationGated} |`,
    `| session-only | ${summary.sessionOnly} |`,
    `| excluded | ${summary.excluded} |`,
    `| **total** | **${summary.total}** |`,
    "",
    "## Policy",
    "",
    "- Bentuk A (`METHOD https://shopee.co.id/path`) only; Worker Connect URLs are not extracted",
    "- Buyer login hops (`/buyer/login`, `authentication/login`, `resend_otp`, `vcode_login`) → `session-only` (`/connect`)",
    "- Account reads are `implemented` only after a captured HAR (`observed`)",
    "- Checkout / pay / chat-send / follow / marketplace search / Open Platform → prose in exclusions.md until a METHOD URL is captured then excluded",
    "- Captured cart write (`POST /api/v4/cart/update`) → `excluded`",
    "- Mutations without a captured XHR → not in this table (ENABLE_MUTATIONS stays false)",
    "- HTML adapters are not planned in v1",
    "- Implemented JSON operations cite `tests/unit/coverage.test.ts`; dispatcher behaviour is covered in `tests/unit/dispatcher.test.ts`",
    "",
    "No sample credentials, cookies, CSRF, OTP, password, or buyer PII appear here.",
    "",
    "## Entries",
    "",
    "| Source md | Method host path | operationId | Auth | R/W | Impl module | Test file | Status | Exclusion reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r} |`),
    "",
  ].join("\n");
}
