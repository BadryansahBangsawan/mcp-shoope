import { assertCsrf, ensureCsrf, readOwner, type OwnerEnv } from "../auth/owner";
import { toAppError } from "../errors/codes";
import { log } from "../observability/log";
import { redactValue } from "../observability/redact";
import { brandRow, esc, htmlResponse, layout } from "../web/html";
import { approvalsStubFor, type ApprovalRecord } from "./mutation-approvals";

export interface ApprovalRoutesEnv extends OwnerEnv {
  MUTATION_APPROVALS: DurableObjectNamespace;
}

const ID_RE = /^\/approvals\/([0-9a-f-]{36})$/;

type NoticeTone = "success" | "danger";

function approvalPage(record: ApprovalRecord, csrf: string, message?: string, noticeTone: NoticeTone = "success"): string {
  const preview = record.preview;
  const expired = Date.now() > record.expiresAt;
  const shownStatus = expired && record.status === "pending" ? "expired" : record.status;
  const statusTone =
    shownStatus === "approved"
      ? "success"
      : shownStatus === "rejected"
        ? "danger"
        : shownStatus === "expired"
          ? "warning"
          : "neutral";
  const statusLabel: Record<string, string> = {
    pending: "Menunggu keputusan",
    approved: "Disetujui sekali",
    rejected: "Ditolak",
    consumed: "Approval terpakai",
    expired: "Kedaluwarsa",
  };
  const details = JSON.stringify(
    { path: preview.path, query: preview.query, body: redactValue(preview.body) },
    null,
    2,
  );
  const notice = message
    ? `<div class="panel panel-${noticeTone}" role="${noticeTone === "danger" ? "alert" : "status"}"><div class="panel-heading"><span class="status-icon" aria-hidden="true">${noticeTone === "danger" ? "!" : "✓"}</span><span>${esc(message)}</span></div></div>`
    : "";
  const actions =
    record.status === "pending" && !expired
      ? `<form method="POST" class="form-stack">
    <input type="hidden" name="csrf" value="${esc(csrf)}"/>
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="btn btn-primary">Setujui sekali</button>
      <button type="submit" name="decision" value="reject" class="btn btn-danger">Tolak</button>
    </div>
  </form>`
      : `<div class="panel panel-${statusTone}">
    <div class="panel-heading">
      <span class="status-icon" aria-hidden="true">${shownStatus === "approved" ? "✓" : shownStatus === "rejected" ? "×" : "!"}</span>
      <span><strong>${esc(statusLabel[shownStatus] ?? shownStatus)}</strong><br/>Permintaan ini tidak bisa diubah lagi.</span>
    </div>
  </div>`;
  return layout(
    "Setujui perubahan",
    `<section class="card" aria-labelledby="approval-title">
  ${brandRow("Persetujuan owner")}
  <header class="card-header">
    <h1 id="approval-title">Setujui perubahan Shopee</h1>
    <p class="subtitle">Tinjau operasi dan argumen persis sebelum mengizinkan perubahan ini.</p>
  </header>
  ${notice}
  <div class="panel panel-${statusTone}">
    <div class="panel-heading">
      <span class="client-mark" aria-hidden="true">&gt;_</span>
      <span class="panel-copy">
        <strong class="panel-title">${esc(preview.title)}</strong>
        <code class="eyebrow">${esc(preview.operationId)}</code>
      </span>
    </div>
    <div class="detail-row">
      <span class="badge badge-${statusTone}">${esc(statusLabel[shownStatus] ?? shownStatus)}</span>
      <span class="badge badge-warning">${esc(preview.safety)}</span>
    </div>
    <div class="detail-row">
      <strong class="detail-label">${esc(preview.method)}</strong>
      <code class="detail-value">${esc(preview.host)}${esc(preview.pathTemplate)}</code>
    </div>
  </div>
  <div class="field">
    <h2 class="section-label">Argumen</h2>
    <pre class="code-block">${esc(details)}</pre>
  </div>
  <p class="muted">Approval sekali pakai, terikat argumen ini, dan kedaluwarsa pada ${esc(new Date(record.expiresAt).toISOString())}.</p>
  ${actions}
  <p class="privacy-note">Hanya perubahan Shopee yang persis ini yang bisa memakai approval.</p>
</section>`,
  );
}

/** Owner-only approval page for pending execute_mutation requests. */
export async function handleApprovalRoutes(request: Request, env: ApprovalRoutesEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ID_RE.exec(url.pathname);
  if (!match) return null;
  const owner = await readOwner(request, env);
  if (!owner) {
    if (request.method === "GET") {
      return new Response(null, {
        status: 302,
        headers: { location: `/login?next=${encodeURIComponent(url.pathname)}`, "cache-control": "no-store" },
      });
    }
    return Response.json({ code: "UNAUTHORIZED", message: "Owner sign-in required" }, { status: 401 });
  }
  const stub = approvalsStubFor(env.MUTATION_APPROVALS, owner.subject);
  const csrf = ensureCsrf(request);
  const cookies = csrf.setCookie ? { "set-cookie": csrf.setCookie } : undefined;
  const record = await stub.get(match[1]!);
  if (!record || record.subject !== owner.subject) {
    return htmlResponse(
      layout(
        "Tidak ditemukan",
        `<section class="card card-compact">${brandRow("Permintaan tertutup")}<header class="card-header"><h1>Approval tidak ditemukan</h1><p class="subtitle">Tautan ini tidak valid atau sudah tidak tersedia.</p></header><div class="panel panel-danger" role="alert">Minta asisten membuat permintaan approval baru.</div></section>`,
      ),
      404,
    );
  }
  if (request.method === "GET") return htmlResponse(approvalPage(record, csrf.token), 200, cookies);
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const form = await request.formData();
  try {
    await assertCsrf(request, String(form.get("csrf") ?? ""));
    const decision = form.get("decision") === "approve" ? "approve" : "reject";
    const updated = await stub.decide({ id: record.id, subject: owner.subject, decision });
    log("info", "mutation.approval.decided", { operationId: updated.operationId, decision });
    const note =
      decision === "approve"
        ? "Disetujui. Minta asisten menjalankan execute_mutation lagi dengan approvalId ini."
        : "Ditolak.";
    return htmlResponse(approvalPage(updated, csrf.token, note, decision === "approve" ? "success" : "danger"), 200, cookies);
  } catch (err) {
    const app = toAppError(err);
    return htmlResponse(approvalPage(record, csrf.token, app?.message ?? "Tidak bisa merekam keputusan", "danger"), app?.status ?? 500, cookies);
  }
}
