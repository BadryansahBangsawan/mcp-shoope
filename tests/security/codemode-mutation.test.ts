import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import type { AuthPrincipal } from "../../src/auth/verify";
import { ErrorCodes } from "../../src/errors/codes";
import { runExecuteMutation } from "../../src/mcp/mutation-tool";
import { createShopeeServer } from "../../src/mcp/server";
import {
  createApprovalsHarness,
  createFakeDispatcher,
  readPrincipal,
  testEnv,
  unusedSessions,
  writePrincipal,
} from "../stubs/codemode-harness";
import { createFakeWorkerLoader } from "../stubs/fake-worker-loader";
import { readWire, rpcRequest } from "../stubs/mcp-wire";

/** v1 has no write ops; unknown ids must not look like a gated mutation. */
const UNKNOWN_WRITE = { operationId: "orders.cancel" };

function mutationServer(opts: { principal?: AuthPrincipal; mutations?: boolean } = {}) {
  const approvals = createApprovalsHarness();
  const dispatcher = createFakeDispatcher({}, { mutationsEnabled: true });
  const handler = createMcpHandler(
    () =>
      createShopeeServer({
        env: testEnv({ LOADER: createFakeWorkerLoader(), ENABLE_MUTATIONS: opts.mutations === false ? "false" : "true" }),
        sessions: unusedSessions,
        principal: opts.principal ?? writePrincipal,
        readDoc: async () => null,
        dispatcher,
        approvals: approvals.stub,
      }),
    { route: "/mcp", legacy: "reject" },
  );
  const callTool = async (args: Record<string, unknown>) => {
    const res = await readWire(await handler.fetch(rpcRequest("tools/call", { name: "execute_mutation", arguments: args })));
    const content = res.body.result?.content as Array<{ text: string }> | undefined;
    const text = content?.[0]?.text ?? "null";
    return { isError: res.body.result?.isError === true, json: parseJson(text), text, raw: res };
  };
  const listTools = async () => {
    const res = await readWire(await handler.fetch(rpcRequest("tools/list")));
    const tools = (res.body.result?.tools as Array<{ name: string }> | undefined) ?? [];
    return tools.map((t) => t.name);
  };
  return { callTool, listTools, approvals, dispatcher };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return (JSON.parse(text) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("execute_mutation is off by default", () => {
  it("is not listed and is a protocol error when mutations are disabled", async () => {
    const s = mutationServer({ mutations: false });
    expect(await s.listTools()).toEqual(["search", "execute"]);
    const res = await s.callTool(UNKNOWN_WRITE);
    expect(res.raw.body.error?.code).toBe(-32602);
  });

  it("is not listed without shopee:write", async () => {
    const s = mutationServer({ principal: readPrincipal });
    expect(await s.listTools()).toEqual(["search", "execute"]);
    const res = await s.callTool(UNKNOWN_WRITE);
    expect(res.raw.body.error?.code).toBe(-32602);
  });
});

describe("execute_mutation when listed (ENABLE_MUTATIONS + write principal + approvals)", () => {
  it("appears on tools/list but unknown writes are UNSUPPORTED_OPERATION, not MUTATION_DISABLED", async () => {
    const s = mutationServer();
    expect(await s.listTools()).toEqual(["search", "execute", "execute_mutation"]);
    const res = await s.callTool(UNKNOWN_WRITE);
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ code: ErrorCodes.UNSUPPORTED_OPERATION });
    expect(s.dispatcher.calls).toHaveLength(0);
  });

  it("rejects a read operationId as INVALID_INPUT", async () => {
    const s = mutationServer();
    const res = await s.callTool({ operationId: "account.profile" });
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(String(res.json.message)).toMatch(/read operation/);
    expect(s.dispatcher.calls).toHaveLength(0);
  });
});

describe("execute_mutation gates (handler level, defence in depth)", () => {
  const approvals = () => createApprovalsHarness();
  const dispatcher = () => createFakeDispatcher({}, { mutationsEnabled: true });

  it("requires shopee:write", async () => {
    await expect(
      runExecuteMutation(
        { env: testEnv({ ENABLE_MUTATIONS: "true" }), principal: readPrincipal, approvals: approvals().stub, dispatcher: dispatcher() },
        UNKNOWN_WRITE,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN });
  });

  it("requires ENABLE_MUTATIONS=true", async () => {
    await expect(
      runExecuteMutation(
        { env: testEnv({ ENABLE_MUTATIONS: "false" }), principal: writePrincipal, approvals: approvals().stub, dispatcher: dispatcher() },
        UNKNOWN_WRITE,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.MUTATION_DISABLED });
  });

  it("unknown write ids are UNSUPPORTED_OPERATION even when mutations are enabled", async () => {
    await expect(
      runExecuteMutation(
        { env: testEnv({ ENABLE_MUTATIONS: "true" }), principal: writePrincipal, approvals: approvals().stub, dispatcher: dispatcher() },
        UNKNOWN_WRITE,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.UNSUPPORTED_OPERATION });
  });
});
