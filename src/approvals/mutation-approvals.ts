import { DurableObject } from "cloudflare:workers";
import { AppError, ErrorCodes } from "../errors/codes";

export const APPROVAL_TTL_MS = 10 * 60_000;

export interface MutationPreview {
  operationId: string;
  title: string;
  safety: string;
  method: string;
  host: string;
  pathTemplate: string;
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ApprovalRecord {
  id: string;
  subject: string;
  operationId: string;
  argsHash: string;
  preview: MutationPreview;
  status: "pending" | "approved" | "rejected" | "consumed";
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  executionId?: string;
}

/** RPC surface used by the Worker (MCP tool + approval page). */
export interface MutationApprovalsStub {
  request(input: { subject: string; operationId: string; argsHash: string; preview: MutationPreview }): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  decide(input: { id: string; subject: string; decision: "approve" | "reject" }): Promise<ApprovalRecord>;
  consume(input: { id: string; subject: string; operationId: string; argsHash: string; executionId: string }): Promise<ApprovalRecord>;
}

/**
 * Per-subject Durable Object holding single-use mutation approvals.
 * An approval is bound to subject + operationId + args hash + expiry and is
 * consumed exactly once (DO input gates make read-check-write atomic).
 * Approval can only be granted by the owner in the browser (/approvals/:id),
 * never by the MCP client that requested it.
 */
export class MutationApprovalsDO extends DurableObject<Env> implements MutationApprovalsStub {
  async request(input: {
    subject: string;
    operationId: string;
    argsHash: string;
    preview: MutationPreview;
  }): Promise<ApprovalRecord> {
    const now = Date.now();
    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      subject: input.subject,
      operationId: input.operationId,
      argsHash: input.argsHash,
      preview: input.preview,
      status: "pending",
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    };
    await this.ctx.storage.put(`approval:${record.id}`, record);
    await this.ctx.storage.setAlarm(record.expiresAt + 60 * 60_000);
    return record;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return (await this.ctx.storage.get<ApprovalRecord>(`approval:${id}`)) ?? null;
  }

  async decide(input: { id: string; subject: string; decision: "approve" | "reject" }): Promise<ApprovalRecord> {
    const record = await this.#load(input.id, input.subject);
    if (record.status !== "pending") {
      throw new AppError(ErrorCodes.INVALID_INPUT, `Approval is already ${record.status}`);
    }
    record.status = input.decision === "approve" ? "approved" : "rejected";
    record.decidedAt = Date.now();
    await this.ctx.storage.put(`approval:${record.id}`, record);
    return record;
  }

  async consume(input: {
    id: string;
    subject: string;
    operationId: string;
    argsHash: string;
    executionId: string;
  }): Promise<ApprovalRecord> {
    const record = await this.#load(input.id, input.subject);
    if (record.operationId !== input.operationId || record.argsHash !== input.argsHash) {
      throw new AppError(ErrorCodes.APPROVAL_REQUIRED, "Approval does not match this operation and arguments");
    }
    if (record.status !== "approved") {
      throw new AppError(ErrorCodes.APPROVAL_REQUIRED, `Approval status is ${record.status}`);
    }
    record.status = "consumed";
    record.executionId = input.executionId;
    await this.ctx.storage.put(`approval:${record.id}`, record);
    return record;
  }

  /** Garbage-collect expired approvals. */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - 60 * 60_000;
    const all = await this.ctx.storage.list<ApprovalRecord>({ prefix: "approval:" });
    const stale = [...all.entries()].filter(([, r]) => r.expiresAt < cutoff).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
  }

  async #load(id: string, subject: string): Promise<ApprovalRecord> {
    const record = await this.get(id);
    if (!record || record.subject !== subject) {
      throw new AppError(ErrorCodes.APPROVAL_REQUIRED, "Approval not found");
    }
    if (Date.now() > record.expiresAt) {
      throw new AppError(ErrorCodes.APPROVAL_REQUIRED, "Approval expired; request a new one");
    }
    return record;
  }
}

export async function hashArgs(args: unknown): Promise<string> {
  const data = new TextEncoder().encode(stableStringify(args));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function approvalsStubFor(ns: DurableObjectNamespace, subject: string): MutationApprovalsStub {
  return ns.get(ns.idFromName(subject)) as unknown as MutationApprovalsStub;
}
