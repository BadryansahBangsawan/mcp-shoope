import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  hashArgs,
  type ApprovalRecord,
  type MutationApprovalsStub,
  type MutationPreview,
} from "../approvals/mutation-approvals";
import { SCOPES } from "../auth/scopes";
import { requireScope, type AuthPrincipal } from "../auth/verify";
import { DEFAULT_CODEMODE_LIMITS } from "../codemode/budget";
import { formatResult } from "../codemode/output";
import type { CodemodeDispatcher } from "../codemode/run";
import { AppError, ErrorCodes } from "../errors/codes";
import { log } from "../observability/log";
import { getOperation } from "../registry/operations";
import type { ApiOperation } from "../registry/types";
import { validateOperationInput, type ValidatedInput } from "../registry/validate";
import { jsonErrorResult, textResult } from "./results";

export const EXECUTE_MUTATION_TOOL = "execute_mutation";

export const executeMutationInput = z.object({
  operationId: z
    .string()
    .min(1)
    .max(128)
    .describe("Registered write or destructive operationId (find it with search, safety != read)"),
  path: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe("Path parameters, e.g. { id: 'abc' }"),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Query parameters"),
  body: z.unknown().optional().describe("JSON body for POST operations"),
  approvalId: z
    .uuid()
    .optional()
    .describe("Omit to request approval; after the owner approves, pass the approvalId returned earlier"),
});

export type ExecuteMutationInput = z.infer<typeof executeMutationInput>;

export interface MutationToolDeps {
  env: Pick<Env, "ENABLE_MUTATIONS" | "PUBLIC_BASE_URL">;
  principal: AuthPrincipal;
  approvals: MutationApprovalsStub;
  dispatcher: CodemodeDispatcher;
  maxOutputTokens?: number;
}

const NEXT_STEP =
  "Ask the owner to open approvalUrl, approve, then call execute_mutation again with the same arguments and approvalId";

/**
 * execute_mutation: one registered write/destructive operation, no model code.
 * Without approvalId it records a pending approval bound to subject +
 * operationId + normalized-args hash and returns APPROVAL_REQUIRED. With
 * approvalId it consumes that approval (single use, same hash, unexpired)
 * and only then dispatches with allowMutation.
 */
export async function runExecuteMutation(
  deps: MutationToolDeps,
  input: ExecuteMutationInput,
): Promise<CallToolResult> {
  requireScope(deps.principal, SCOPES.WRITE);
  if (deps.env.ENABLE_MUTATIONS !== "true") {
    throw new AppError(ErrorCodes.MUTATION_DISABLED, "Mutations are disabled (ENABLE_MUTATIONS is not true)");
  }
  const op = mutationOperation(input.operationId);
  const normalized = validateOperationInput(op, {
    path: input.path,
    query: input.query,
    body: input.body,
  });
  const argsHash = await hashArgs({
    operationId: op.operationId,
    path: normalized.path,
    query: normalized.query,
    body: normalized.body,
  });
  const subject = deps.principal.subject;

  if (!input.approvalId) {
    const origin = approvalOrigin(deps.env.PUBLIC_BASE_URL);
    const record = await deps.approvals.request({
      subject,
      operationId: op.operationId,
      argsHash,
      preview: previewFor(op, normalized),
    });
    log("info", "mutation.approval.requested", { operationId: op.operationId, approvalId: record.id });
    return approvalRequired(record, origin);
  }

  await deps.dispatcher.preflight?.({ operationId: op.operationId, ...normalized }, { allowMutation: true });
  const executionId = crypto.randomUUID();
  await deps.approvals.consume({
    id: input.approvalId,
    subject,
    operationId: op.operationId,
    argsHash,
    executionId,
  });
  log("info", "mutation.execute.start", { operationId: op.operationId, executionId });
  const result = await deps.dispatcher.dispatch(
    { operationId: op.operationId, ...normalized },
    { allowMutation: true },
  );
  log("info", "mutation.execute.done", { operationId: op.operationId, executionId, status: result.status });
  const maxTokens = deps.maxOutputTokens ?? DEFAULT_CODEMODE_LIMITS.maxOutputTokens;
  return textResult(
    formatResult({ executionId, operationId: op.operationId, status: result.status, data: result.data }, maxTokens),
  );
}

function mutationOperation(operationId: string): ApiOperation {
  const op = getOperation(operationId);
  if (!op || !op.exposed) {
    throw new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `Unknown operationId ${operationId}`);
  }
  if (op.safety === "read") {
    throw new AppError(
      ErrorCodes.INVALID_INPUT,
      `${operationId} is a read operation; use the execute tool for reads`,
    );
  }
  return op;
}

function previewFor(op: ApiOperation, input: ValidatedInput): MutationPreview {
  return {
    operationId: op.operationId,
    title: op.title,
    safety: op.safety,
    method: op.method,
    host: op.host,
    pathTemplate: op.pathTemplate,
    path: input.path,
    query: input.query,
    body: input.body,
  };
}

function approvalOrigin(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw?.trim() ?? "");
  } catch {
    throw new AppError(ErrorCodes.MUTATION_DISABLED, "PUBLIC_BASE_URL is not configured; approvals are unavailable");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !loopback) {
    throw new AppError(ErrorCodes.MUTATION_DISABLED, "PUBLIC_BASE_URL must be https; approvals are unavailable");
  }
  return url.origin;
}

function approvalRequired(record: ApprovalRecord, origin: string): CallToolResult {
  return jsonErrorResult({
    code: ErrorCodes.APPROVAL_REQUIRED,
    message: "Owner approval is required before this change runs",
    approvalId: record.id,
    approvalUrl: `${origin}/approvals/${record.id}`,
    expiresAt: new Date(record.expiresAt).toISOString(),
    preview: record.preview,
    next: NEXT_STEP,
  });
}
