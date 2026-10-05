import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import type { AuthPrincipal } from "../../src/auth/verify";
import { createShopeeServer } from "../../src/mcp/server";
import { DOC_NAMES } from "../../src/mcp/resources";
import {
  createApprovalsHarness,
  createFakeDispatcher,
  readPrincipal,
  testEnv,
  unusedSessions,
  writePrincipal,
} from "../stubs/codemode-harness";
import { createFakeWorkerLoader } from "../stubs/fake-worker-loader";
import { MODERN_VERSION, readWire, rpcMessage, rpcRequest, type WireOptions } from "../stubs/mcp-wire";

interface Setup {
  mutations?: boolean;
  principal?: AuthPrincipal;
}

/** The production server factory behind the Agents SDK stateless handler, legacy rejected. */
function handlerFor(setup: Setup = {}) {
  const approvals = createApprovalsHarness();
  return createMcpHandler(
    () =>
      createShopeeServer({
        env: testEnv({
          LOADER: createFakeWorkerLoader(),
          ENABLE_MUTATIONS: setup.mutations ? "true" : "false",
        }),
        sessions: unusedSessions,
        principal: setup.principal ?? readPrincipal,
        readDoc: async (name) => `# ${name}\n\nSample phone 081234567890.`,
        dispatcher: createFakeDispatcher({
          "account.profile": () => ({ username: "buyer" }),
        }),
        approvals: approvals.stub,
      }),
    { route: "/mcp", legacy: "reject" },
  );
}

async function call(method: string, params: Record<string, unknown> = {}, options: WireOptions = {}, setup: Setup = {}) {
  return readWire(await handlerFor(setup).fetch(rpcRequest(method, params, options)));
}

type ToolInfo = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: { required?: string[] };
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
};

describe("2026-07-28 negotiation", () => {
  it("server/discover advertises only 2026-07-28 and no list-changed notifications", async () => {
    const res = await call("server/discover");
    expect(res.status).toBe(200);
    const result = res.body.result!;
    expect(result.supportedVersions).toEqual([MODERN_VERSION]);
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
    expect(result._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: "shopee-mcp-test", version: "0.0.0-test" },
    });
  });

  it("rejects an unsupported protocol version with -32022", async () => {
    const res = await call("tools/list", {}, { version: "2025-06-18" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(-32022);
    expect(res.body.error?.data).toMatchObject({ supported: [MODERN_VERSION], requested: "2025-06-18" });
  });

  it("rejects a legacy initialize handshake", async () => {
    const res = await call(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
      { bare: true },
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(-32022);
  });

  it("serves stateless Streamable HTTP: POST only, no session id, independent requests", async () => {
    const handler = handlerFor();
    const get = await handler.fetch(
      new Request("http://localhost/mcp", { method: "GET", headers: { host: "localhost", accept: "text/event-stream" } }),
    );
    expect(get.status).toBe(405);
    const first = await handler.fetch(rpcRequest("tools/list"));
    expect(first.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeNull();
    const second = await readWire(await handler.fetch(rpcRequest("prompts/list", {}, { id: 2 })));
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(2);
  });

  it("rejects JSON-RPC batches", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_VERSION,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify([rpcMessage("tools/list", {}, { id: 1 }), rpcMessage("prompts/list", {}, { id: 2 })]),
    });
    const res = await readWire(await handlerFor().fetch(request));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(-32600);
  });
});

describe("tools", () => {
  it("read-only callers see search and execute with read-only annotations", async () => {
    const tools = (await call("tools/list")).body.result!.tools as ToolInfo[];
    expect(tools.map((t) => t.name)).toEqual(["search", "execute"]);
    const [search, execute] = tools;
    expect(search!.title).toBe("Cari katalog API akun buyer");
    expect(search!.description).toContain("katalog API akun buyer");
    expect(search!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(execute!.title).toBe("Baca data hidup akun buyer");
    expect(execute!.description).toContain("akun buyer");
    expect(execute!.description).not.toContain("shop.info");
    expect(execute!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    for (const tool of [search!, execute!]) {
      expect(tool.description!.length).toBeLessThanOrEqual(600);
      expect(tool.description).toContain("Contoh:");
      expect(tool.inputSchema.required).toEqual(["code"]);
    }
  });

  it("execute_mutation is listed only with ENABLE_MUTATIONS=true, shopee:write, and approvals", async () => {
    const names = async (setup: Setup) =>
      ((await call("tools/list", {}, {}, setup)).body.result!.tools as ToolInfo[]).map((t) => t.name);
    expect(await names({ mutations: false, principal: writePrincipal })).toEqual(["search", "execute"]);
    expect(await names({ mutations: true, principal: readPrincipal })).toEqual(["search", "execute"]);
    const tools = (await call("tools/list", {}, {}, { mutations: true, principal: writePrincipal })).body.result!
      .tools as ToolInfo[];
    expect(tools.map((t) => t.name)).toEqual(["search", "execute", "execute_mutation"]);
    const mutation = tools.find((t) => t.name === "execute_mutation");
    expect(mutation?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(mutation?.description!.length).toBeLessThanOrEqual(600);
    expect(mutation?.description).toContain("Checkout/bayar tidak didukung");
    expect(mutation?.inputSchema.required).toEqual(["operationId"]);
  });

  it("calling an unregistered execute_mutation is a protocol error", async () => {
    const res = await call("tools/call", { name: "execute_mutation", arguments: { operationId: "orders.cancel" } });
    expect(res.body.error?.code).toBe(-32602);
  });

  it("tools/call search sees captured buyer reads in the catalog", async () => {
    const res = await call("tools/call", {
      name: "search",
      arguments: {
        code: "async () => { const { catalog } = await codemode.spec(); return Array.isArray(catalog) && catalog.some(o => o.operationId === 'account.profile') && catalog.some(o => o.operationId === 'orders.list'); }",
      },
    });
    expect(res.body.result?.content).toEqual([{ type: "text", text: "true" }]);
    expect(res.body.result?.isError).toBeUndefined();
  });

  it("unknown execute op orders.cancel is UNSUPPORTED_OPERATION, not MUTATION_DISABLED", async () => {
    const res = await call("tools/call", {
      name: "execute",
      arguments: { code: "async () => codemode.request({ operationId: 'orders.cancel' })" },
    });
    expect(res.body.result?.isError).toBe(true);
    const content = res.body.result?.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(JSON.parse(content[0]!.text).code).not.toBe("MUTATION_DISABLED");
  });
});

describe("resources", () => {
  it("lists the static resources and every document from the template, with no ui:// views", async () => {
    const resources = (await call("resources/list")).body.result!.resources as Array<{
      uri: string;
      name: string;
      mimeType?: string;
    }>;
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "shopee://docs/index",
        "shopee://openapi",
        "shopee://capabilities",
        "shopee://coverage",
      ]),
    );
    for (const name of DOC_NAMES) expect(uris).toContain(`shopee://docs/${name}`);
    expect(uris.filter((u) => u.startsWith("ui://"))).toEqual([]);
    expect(uris).toHaveLength(4 + DOC_NAMES.length);
  });

  it("lists the shopee://docs/{document} template", async () => {
    const templates = (await call("resources/templates/list")).body.result!.resourceTemplates as Array<{
      uriTemplate: string;
    }>;
    expect(templates.map((t) => t.uriTemplate)).toEqual(["shopee://docs/{document}"]);
  });

  it("reads every listed resource", async () => {
    const resources = (await call("resources/list")).body.result!.resources as Array<{ uri: string }>;
    for (const { uri } of resources) {
      const res = await call("resources/read", { uri });
      expect(res.body.error, uri).toBeUndefined();
      const contents = res.body.result!.contents as Array<{ uri: string; text: string; mimeType?: string }>;
      expect(contents).toHaveLength(1);
      expect(contents[0]!.uri).toBe(uri);
      expect(contents[0]!.text.length).toBeGreaterThan(0);
      if (uri.startsWith("shopee://docs/") && uri !== "shopee://docs/index") {
        expect(contents[0]!.text).not.toContain("081234567890");
      }
    }
  });

  it("returns resource-not-found for unknown documents", async () => {
    for (const uri of ["shopee://docs/nope", "shopee://docs/..%2Fsecrets", "shopee://unknown"]) {
      const res = await call("resources/read", { uri });
      expect(res.body.error?.code, uri).toBe(-32602);
      expect(res.body.error?.data).toEqual({ uri });
    }
  });
});

describe("prompts", () => {
  it("lists the three prompts with all arguments optional", async () => {
    const prompts = (await call("prompts/list")).body.result!.prompts as Array<{
      name: string;
      arguments?: Array<{ name: string; required: boolean }>;
    }>;
    expect(prompts.map((p) => p.name)).toEqual(["riwayat-beli", "detail-pesanan", "ringkas-akun"]);
    expect(prompts[0]!.arguments).toEqual([expect.objectContaining({ name: "days", required: false })]);
    expect(prompts[1]!.arguments).toEqual([expect.objectContaining({ name: "order_id", required: false })]);
    expect(prompts[2]!.arguments ?? []).toEqual([]);
    for (const prompt of prompts) {
      expect((prompt.arguments ?? []).filter((a) => a.required)).toEqual([]);
    }
  });

  it("gets riwayat-beli with no arguments object at all", async () => {
    const res = await call("prompts/get", { name: "riwayat-beli" });
    expect(res.body.error).toBeUndefined();
    const messages = res.body.result!.messages as Array<{ content: { text: string } }>;
    expect(messages[0]!.content.text).toContain("14 hari terakhir");
  });

  it("gets prompts with optional arguments", async () => {
    const period = await call("prompts/get", { name: "riwayat-beli", arguments: { days: "7" } });
    expect((period.body.result!.messages as Array<{ content: { text: string } }>)[0]!.content.text).toContain(
      "7 hari terakhir",
    );
    const detail = await call("prompts/get", { name: "detail-pesanan", arguments: { order_id: "220101ABCDEF" } });
    expect(detail.body.error).toBeUndefined();
    expect((detail.body.result!.messages as Array<{ content: { text: string } }>)[0]!.content.text).toContain(
      "Ambil detail pesanan untuk id: 220101ABCDEF",
    );
    const ringkas = await call("prompts/get", { name: "ringkas-akun", arguments: {} });
    expect(ringkas.body.error).toBeUndefined();
    expect((ringkas.body.result!.messages as Array<{ content: { text: string } }>)[0]!.content.text).toContain(
      "Ringkas akun buyer",
    );
    expect((ringkas.body.result!.messages as Array<{ content: { text: string } }>)[0]!.content.text).not.toContain(
      "SKU",
    );
  });
});
