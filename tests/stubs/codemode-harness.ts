import { vi } from "vitest";
import {
  MutationApprovalsDO,
  type MutationApprovalsStub,
} from "../../src/approvals/mutation-approvals";
import type { AuthPrincipal } from "../../src/auth/verify";
import type { CodemodeDispatcher } from "../../src/codemode/run";
import type { DispatchRequest, DispatchResult } from "../../src/dispatcher/shopee-dispatcher";
import { AppError, ErrorCodes } from "../../src/errors/codes";
import { getOperation } from "../../src/registry/operations";
import { validateOperationInput } from "../../src/registry/validate";
import type { ShopeeSessionProvider } from "../../src/session/types";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENABLE_MUTATIONS: "false",
    ENABLE_WIDGETS: "false",
    PUBLIC_BASE_URL: "https://mcp.example.test",
    MCP_SERVER_NAME: "shopee-mcp-test",
    MCP_SERVER_VERSION: "0.0.0-test",
    MCP_LEGACY_MODE: "reject",
    SHOPEE_REGION: "ID",
    ...overrides,
  } as Env;
}

export const readPrincipal: AuthPrincipal = { subject: "owner", scopes: ["shopee:read"], via: "oauth" };
export const writePrincipal: AuthPrincipal = {
  subject: "owner",
  scopes: ["shopee:read", "shopee:write"],
  via: "oauth",
};

/** Session provider that must never be reached when a fake dispatcher is injected. */
export const unusedSessions: ShopeeSessionProvider = {
  getSession: async () => {
    throw new Error("sessions must not be used in this test");
  },
  markExpired: () => undefined,
};

export type FixtureHandler = (
  req: DispatchRequest,
  opts: { allowMutation?: boolean; signal?: AbortSignal } | undefined,
) => unknown;

export interface FakeDispatcher extends CodemodeDispatcher {
  readonly calls: Array<{ req: DispatchRequest; opts?: { allowMutation?: boolean; signal?: AbortSignal } }>;
  readonly peakInFlight: number;
}

/**
 * Dispatcher double: validates input with the real registry validator when the
 * op is known (FAKE_OPS overlay or real catalog), enforces the read-only gate,
 * then answers from fixture handlers. If `getOperation` misses but a handler
 * exists, skip schema so budget tests still work. Unknown ops without a handler
 * throw UNSUPPORTED and are not recorded on `calls`.
 */
export function createFakeDispatcher(
  handlers: Record<string, FixtureHandler>,
  options: { mutationsEnabled?: boolean } = {},
): FakeDispatcher {
  const calls: FakeDispatcher["calls"] = [];
  let inFlight = 0;
  let peak = 0;

  async function invoke(
    req: DispatchRequest,
    opts: { allowMutation?: boolean; signal?: AbortSignal } | undefined,
    handler: FixtureHandler,
  ): Promise<DispatchResult> {
    calls.push({ req, opts });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      const data = await handler(req, opts);
      return { operationId: req.operationId, status: 200, data };
    } finally {
      inFlight -= 1;
    }
  }

  return {
    calls,
    get peakInFlight() {
      return peak;
    },
    async dispatch(req, opts): Promise<DispatchResult> {
      const op = getOperation(req.operationId);
      const handler = handlers[req.operationId];
      if (!op || !op.exposed) {
        if (!handler) {
          throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `Unknown operation: ${req.operationId}`);
        }
        return invoke(req, opts, handler);
      }
      if (op.safety !== "read" && !(options.mutationsEnabled && opts?.allowMutation === true)) {
        throw new AppError(ErrorCodes.MUTATION_DISABLED, "Mutations are disabled");
      }
      const input = validateOperationInput(op, {
        path: req.path,
        query: req.query as Record<string, string | number | boolean> | undefined,
        body: req.body,
      });
      void input;
      if (!handler) {
        throw new AppError(ErrorCodes.UPSTREAM_ERROR, `No fixture for ${req.operationId}`);
      }
      return invoke(req, opts, handler);
    },
    async preflight(req, opts): Promise<void> {
      await this.dispatch(req, opts);
    },
  };
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function createApprovalsHarness(): { stub: MutationApprovalsStub; do: MutationApprovalsDO | null } {
  const records = new Map<string, Awaited<ReturnType<MutationApprovalsStub["get"]>>>();
  const stub: MutationApprovalsStub = {
    request: async (input) => {
      const rec = {
        id: crypto.randomUUID(),
        subject: input.subject,
        operationId: input.operationId,
        argsHash: input.argsHash,
        preview: input.preview,
        status: "pending" as const,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      };
      records.set(rec.id, rec);
      return rec;
    },
    get: async (id) => records.get(id) ?? null,
    decide: async (input) => {
      const rec = records.get(input.id);
      if (!rec) throw new AppError(ErrorCodes.INVALID_INPUT, "approval missing");
      const next = {
        ...rec,
        status: input.decision === "approve" ? ("approved" as const) : ("rejected" as const),
        decidedAt: Date.now(),
      };
      records.set(input.id, next);
      return next;
    },
    consume: async (input) => {
      const rec = records.get(input.id);
      if (!rec) throw new AppError(ErrorCodes.INVALID_INPUT, "approval missing");
      const next = { ...rec, status: "consumed" as const, executionId: input.executionId };
      records.set(input.id, next);
      return next;
    },
  };
  return { stub, do: null };
}

vi.mock("cloudflare:workers", () => ({}));
