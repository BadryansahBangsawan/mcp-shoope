import type { CallToolResult } from "@modelcontextprotocol/server";
import { toAppError } from "../codemode/errors";
import { ErrorCodes } from "../errors/codes";

/** Successful tool result carrying exactly one, already size-capped, text block. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Tool error with a JSON body. `payload` must already be safe to show the model. */
export function jsonErrorResult(payload: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Map any thrown value to a typed tool error. Only code + message leave the
 * server (no details, cause or stack); AppErrors that crossed a Durable Object
 * boundary are recognised structurally. Unknown errors get a generic message.
 */
export function errorResult(err: unknown): CallToolResult {
  const app = toAppError(err);
  if (app) return jsonErrorResult({ code: app.code, message: app.message });
  return jsonErrorResult({ code: ErrorCodes.UPSTREAM_ERROR, message: "Internal error while running the tool" });
}

/** Error code for structured logs, without the (possibly model-controlled) message. */
export function errorCodeOf(err: unknown): string {
  return toAppError(err)?.code ?? (err instanceof Error ? err.name : typeof err);
}
