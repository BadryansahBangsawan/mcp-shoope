import { ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { CodemodeLimits } from "../codemode/budget";
import { APPROVAL_TTL_MS } from "../approvals/mutation-approvals";
import { buildCoverageManifest, coverageSummary } from "../registry/coverage";
import { API_DOC_NAMES } from "../registry/doc-endpoints";
import { buildOpenApiDocument } from "../registry/openapi";
import { listExposedOperations } from "../registry/operations";
import { sanitizeDocMarkdown } from "../observability/redact";

/** Sanitized API docs served under shopee://docs/{document}. */
export const DOC_NAMES: readonly string[] = API_DOC_NAMES;

const DOC_SET = new Set<string>(DOC_NAMES);
const PROTOCOL_VERSION = "2026-07-28";

export interface CapabilitiesInfo {
  tools: string[];
  mutationsEnabled: boolean;
  limits: CodemodeLimits;
  widgetsEnabled: boolean;
}

function docUri(name: string): string {
  return `shopee://docs/${name}`;
}

function jsonContents(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

export function registerResources(
  server: McpServer,
  options: {
    readDoc: (name: string) => Promise<string | null>;
    capabilities: CapabilitiesInfo;
  },
): void {
  server.registerResource(
    "docs-index",
    "shopee://docs/index",
    {
      title: "Indeks dokumen API Shopee",
      description: "Indeks dokumen API akun buyer yang sudah di-sanitize",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(uri.href, {
        documents: DOC_NAMES.map((name) => ({ name, uri: docUri(name) })),
      }),
  );

  server.registerResource(
    "docs",
    new ResourceTemplate("shopee://docs/{document}", {
      list: async () => ({
        resources: DOC_NAMES.map((name) => ({ uri: docUri(name), name, mimeType: "text/markdown" })),
      }),
    }),
    {
      title: "Dokumen API Shopee",
      description: "Satu dokumen API yang sudah di-sanitize (lihat shopee://docs/index)",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const name = variables.document;
      if (typeof name !== "string" || !DOC_SET.has(name)) throw new ResourceNotFoundError(uri.href);
      const raw = await options.readDoc(name);
      if (raw === null) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: docUri(name), mimeType: "text/markdown", text: sanitizeDocMarkdown(raw) }] };
    },
  );

  server.registerResource(
    "openapi",
    "shopee://openapi",
    {
      title: "OpenAPI 3.1 akun buyer Shopee",
      description: "Dokumen OpenAPI 3.1 yang dihasilkan dari registry operasi baca akun",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, buildOpenApiDocument()),
  );

  server.registerResource(
    "capabilities",
    "shopee://capabilities",
    {
      title: "Kapabilitas server",
      description: "Tool yang terdaftar untuk pemanggil ini, kebijakan mutasi, dan limit Code Mode",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, capabilitiesPayload(options.capabilities)),
  );

  server.registerResource(
    "coverage",
    "shopee://coverage",
    {
      title: "Manifest coverage API",
      description: "Status coverage setiap endpoint shopee.co.id yang terdokumentasi",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri.href, { summary: coverageSummary(), entries: buildCoverageManifest() }),
  );
}

function capabilitiesPayload(info: CapabilitiesInfo): Record<string, unknown> {
  const ops = listExposedOperations();
  const count = (safety: string) => ops.filter((o) => o.safety === safety).length;
  return {
    protocol: PROTOCOL_VERSION,
    tools: info.tools,
    progressiveDiscovery: true,
    operations: { exposed: ops.length, read: count("read"), write: count("write"), destructive: count("destructive") },
    mutations: {
      enabled: info.mutationsEnabled,
      toolAvailable: info.tools.includes("execute_mutation"),
      approval: `Owner menyetujui setiap panggilan di browser; sekali pakai, terikat operasi + argumen, kedaluwarsa setelah ${Math.round(APPROVAL_TTL_MS / 60_000)} menit`,
    },
    codeMode: {
      timeoutMs: info.limits.timeoutMs,
      maxRequests: info.limits.maxRequests,
      maxConcurrency: info.limits.maxConcurrency,
      maxResponseChars: info.limits.maxResponseChars,
      maxOutputChars: info.limits.maxOutputTokens * 4,
      network: "none except codemode.request() by operationId",
    },
    widgets: {
      enabled: info.widgetsEnabled,
      views: [],
      resourceUris: [],
    },
  };
}
