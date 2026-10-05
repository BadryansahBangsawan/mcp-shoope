# Fase 8 — mutasi (opsional, default OFF)

Jangan hidupkan di produksi sampai keempat gerbang + tes keamanan hijau.

## 8.1 Empat gerbang

1. `ENABLE_MUTATIONS=true` (var wrangler, bukan dashboard).
2. Token punya `write` atau `admin`.
3. Operasi terdaftar `safety: write | destructive` (efek, bukan verb).
4. Approval di DO: subject + `operationId` + SHA-256 argumen ternormalisasi (stable stringify, key terurut, `undefined` di-drop), TTL **10 menit**, sekali pakai, consume atomik.

Instance DO: `idFromName(subject)`. Alarm GC 1 jam setelah expiry.

## 8.2 Alur tool `execute_mutation`

**Tanpa** kode model — input terstruktur, bukan sandbox.

1. Tanpa `approvalId` → simpan pending, return `APPROVAL_REQUIRED` + `approvalUrl` + `expiresAt` + preview (body di-redact) + `nextStep` (“owner buka URL, lalu panggil lagi dengan approvalId”).
2. Owner buka `/approvals/<uuid>` di browser (cookie + CSRF). Approve once / Reject. Klien MCP **tidak bisa** approve.
3. Panggil lagi argumen identik + `approvalId`. Urutan wajib: **`preflight` dulu → `consume` → `dispatch({ allowMutation: true })`**. Gagal lokal (tidak ada sesi, input salah) tidak boleh menghabiskan approval.
4. Hasil teks: `{ executionId, operationId, status, data }` (di-cap seperti execute).

Mismatch subject / operationId / hash / status bukan `approved` / expired → `APPROVAL_REQUIRED`.

Log: `mutation.approval.requested`, `mutation.approval.decided`, `mutation.execute.start`, `mutation.execute.done` — id saja, tanpa body.

## 8.3 Preview di halaman owner

Tampilkan `operationId`, title, safety, method, path template, argumen yang sudah di-redact (key/pattern yang sama dengan logger). Jangan tampilkan token. Tombol Approve once / Reject. CSRF wajib.

## 8.4 Tes

`tests/security/codemode-mutation.test.ts`. E2E **tidak** memanggil mutasi.

Produksi tetap `ENABLE_MUTATIONS=false` sampai ada alasan bisnis + runbook owner.

Modul `src/approvals/*` **platform-agnostik** — copy utuh.
