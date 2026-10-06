import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { APPROVAL_TTL_MS, type MutationApprovalsStub } from "../approvals/mutation-approvals";
import { hasScope, SCOPES } from "../auth/scopes";
import { requireScope, type AuthPrincipal } from "../auth/verify";
import { DEFAULT_CODEMODE_LIMITS, type CodemodeLimits } from "../codemode/budget";
import { runCodemode, type CodemodeDispatcher } from "../codemode/run";
import { createSpecBundle } from "../codemode/spec";
import { ShopeeDispatcher } from "../dispatcher/shopee-dispatcher";
import { log } from "../observability/log";
import type { ShopeeSessionProvider } from "../session/types";
import { EXECUTE_MUTATION_TOOL, executeMutationInput, runExecuteMutation } from "./mutation-tool";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { errorCodeOf, errorResult, textResult } from "./results";

export interface ServerDeps {
  env: Env;
  sessions: ShopeeSessionProvider;
  principal: AuthPrincipal;
  readDoc: (name: string) => Promise<string | null>;
  approvals?: MutationApprovalsStub;
  dispatcher?: CodemodeDispatcher;
  limits?: Partial<CodemodeLimits>;
}

const codeInput = z.object({
  code: z
    .string()
    .min(1)
    .max(20_000)
    .describe("An async JavaScript arrow function, e.g. async () => { ...; return result; }"),
});

function searchDescription(): string {
  return [
    "Cari katalog API akun buyer ini: operationId, parameter, kelas safety, dan skema OpenAPI 3.1.",
    "Menjalankan fungsi panah async JavaScript di sandbox terisolasi tanpa jaringan; `codemode.spec()` menghasilkan { catalog, openapi, examples }.",
    "Pakai sebelum execute untuk menemukan operationId dan input wajib; kembalikan hanya field yang dibutuhkan.",
    "Contoh: async () => (await codemode.spec()).catalog.map(o => ({ id: o.operationId, inputs: o.inputKeys }))",
  ].join(" ");
}

function executeDescription(limits: CodemodeLimits): string {
  return [
    "Baca data hidup akun buyer (riwayat beli, keranjang, profil, voucher, notifikasi, koin).",
    "Menjalankan fungsi panah async JavaScript di sandbox terisolasi di mana `codemode.request({ operationId, path, query, body })` memanggil satu operasi baca terdaftar dan menghasilkan { operationId, status, data }.",
    "Operasi tulis, fetch(), serta method/url/headers ditolak. Jangan dump PII.",
    `Per run: ${limits.maxRequests} request, ${limits.maxConcurrency} concurrent, ~${Math.round(limits.maxResponseChars / 1_000_000)} MB respons, ${Math.round(limits.timeoutMs / 1000)} dtk.`,
    'Contoh: async () => codemode.request({ operationId: "account.profile" })',
  ].join(" ");
}

function mutationDescription(): string {
  return [
    "Ubah data akun (operasi write/destructive yang sudah terdaftar), satu operasi per panggilan, hanya setelah owner menyetujui di browser.",
    "Panggil tanpa approvalId dulu: mengembalikan APPROVAL_REQUIRED dengan approvalUrl, expiresAt, dan preview.",
    `Setelah disetujui, panggil lagi dengan operationId/path/query/body yang identik plus approvalId; approval sekali pakai dan kedaluwarsa setelah ${Math.round(APPROVAL_TTL_MS / 60_000)} menit.`,
    "Mutasi default OFF di v1. Checkout/bayar tidak didukung.",
  ].join(" ");
}

export function createShopeeServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: deps.env.MCP_SERVER_NAME || "shopee-mcp",
      version: deps.env.MCP_SERVER_VERSION || "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
    },
  );

  const spec = createSpecBundle();
  const limits: CodemodeLimits = { ...DEFAULT_CODEMODE_LIMITS, ...deps.limits };
  const mutationsEnabled = deps.env.ENABLE_MUTATIONS === "true";
  const dispatcher: CodemodeDispatcher =
    deps.dispatcher ??
    new ShopeeDispatcher({
      sessions: deps.sessions,
      mutationsEnabled,
    });
  const tools: string[] = [];
  const approvals = deps.approvals;
  const mutationToolAvailable = Boolean(
    mutationsEnabled && approvals && hasScope(deps.principal.scopes, SCOPES.WRITE),
  );

  server.registerTool(
    "search",
    {
      title: "Cari katalog API akun buyer",
      description: searchDescription(),
      inputSchema: codeInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ code }) => {
      try {
        requireScope(deps.principal, SCOPES.READ);
        return textResult(await runCodemode({ loader: deps.env.LOADER, code, mode: "search", spec, limits }));
      } catch (err) {
        log("warn", "tool.search.error", { code: errorCodeOf(err) });
        return errorResult(err);
      }
    },
  );
  tools.push("search");

  server.registerTool(
    "execute",
    {
      title: "Baca data hidup akun buyer",
      description: executeDescription(limits),
      inputSchema: codeInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ code }) => {
      try {
        requireScope(deps.principal, SCOPES.READ);
        return textResult(
          await runCodemode({
            loader: deps.env.LOADER,
            code,
            mode: "execute",
            spec,
            dispatcher,
            limits,
            mutationToolAvailable,
          }),
        );
      } catch (err) {
        log("warn", "tool.execute.error", { code: errorCodeOf(err) });
        return errorResult(err);
      }
    },
  );
  tools.push("execute");

  if (mutationToolAvailable && approvals) {
    server.registerTool(
      EXECUTE_MUTATION_TOOL,
      {
        title: "Jalankan perubahan Shopee yang disetujui",
        description: mutationDescription(),
        inputSchema: executeMutationInput,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (input) => {
        try {
          return await runExecuteMutation(
            {
              env: deps.env,
              principal: deps.principal,
              approvals,
              dispatcher,
              maxOutputTokens: limits.maxOutputTokens,
            },
            input,
          );
        } catch (err) {
          log("warn", "tool.execute_mutation.error", { code: errorCodeOf(err), operationId: input.operationId });
          return errorResult(err);
        }
      },
    );
    tools.push(EXECUTE_MUTATION_TOOL);
  }

  const widgetsEnabled = deps.env.ENABLE_WIDGETS === "true";

  registerResources(server, {
    readDoc: deps.readDoc,
    capabilities: { tools, mutationsEnabled, limits, widgetsEnabled },
  });
  registerPrompts(server);

  return server;
}
