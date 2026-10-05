# Fase 6 — MCP server: `search` + `execute`

`src/mcp/server.ts` membuat `McpServer` **per request**.

```
new McpServer({ name, version }, {
  capabilities: {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false },
  },
})
```

## 6.1 Tool `search` dan `execute`

Keduanya: satu argumen `{ code: string }` **1–20_000** karakter, async arrow function.

Deskripsi tool **wajib** menyebut:

- apa yang bisa dilakukan (bukan “call the API”)
- bahwa yang dijalankan adalah JS di sandbox
- contoh 1 baris yang benar-benar jalan
- batas (jumlah request, detik, MB)

Anotasi:

- `search`: `readOnlyHint`, `idempotentHint`, `openWorldHint: false`
- `execute`: `readOnlyHint`, `openWorldHint: true`

Handler: `requireScope(READ)` → `runCodemode(...)` → `textResult` / `errorResult`. Log `tool.<name>.error` **hanya** kode error.

Urutan pabrik:

1. Selalu `search` + `execute`.
2. `execute_mutation` hanya jika `ENABLE_MUTATIONS==="true"` **dan** approvals stub ada **dan** principal punya write/admin.
3. Widget tools + `ui://` kecuali `ENABLE_WIDGETS==="false"` (default hidup).

## 6.2 Code Mode — copy utuh (platform-agnostik)

`DynamicWorkerExecutor({ loader, timeout, globalOutbound: null })`. CPU limit isolate lewat wrapper `loader.load`/`get`.

Host functions (`codemode` namespace). `spec` selalu terpasang. `request` **hanya** jika `mode === "execute"` **dan** dispatcher ada.

| Mode | `codemode.spec()` | `codemode.request()` | Dispatcher |
| --- | --- | --- | --- |
| `search` | ya | **tidak** (`Tool "request" not found`) | diabaikan meski di-pass |
| `execute` | ya | ya, **read-only** | wajib (tanpa dispatcher → `INVALID_INPUT`) |

Kontrak `request()`:

- Hanya key `operationId|path|query|body`.
- `operationId` wajib, input harus object.
- Path value = string/number. Query = string/number/boolean. Bukan objek.
- Host menolak operasi non-read **sebelum** dispatcher (pesan menyebut `execute_mutation` jika tool itu terdaftar).

`ExecutionBudget` **terminal** (script tidak bisa `catch` lalu lanjut memanggil):

| Limit | Nilai |
| --- | --- |
| `timeoutMs` | 30_000 |
| `maxRequests` | 50 |
| `maxConcurrency` | 4 |
| `maxResponseChars` | 5_000_000 |
| `maxSpecCalls` | 20 |
| `maxSandboxResultChars` | 1_000_000 |
| `maxOutputTokens` | 6_000 (~24 KB, 4 char/token) |
| `cpuMs` | 10_000 |

Program sandbox: strip fence markdown, trailing `;`, bungkus supaya throw non-Error tetap ada pesannya, `JSON.stringify` **di dalam isolate**, cap ukuran, host menerima `{ __json }` — jangan structured-clone objek raksasa.

Error bridge:

- Ke sandbox dan ke klien hanya `CODE: message`.
- AppError yang menyeberang RPC (plain `Error` + `name: "AppError"` + `code`) di-rehydrate. Kode tidak dikenal → `UPSTREAM_ERROR`.
- Throw host tak terduga (TypeError berisi token) → `UPSTREAM_ERROR` generic, message tidak boleh bawa secret.
- Script model yang throw / tidak compile → `INVALID_INPUT`. Kode palsu di message model **tidak** dipercaya.

Output akhir (`formatResult`): truncate struktural (JSON tetap valid) lalu hard-cap. `undefined` → pesan “return a value”.

## 6.3 Hasil tool

- Sukses: satu blok teks.
- Error: `isError: true`, body JSON `{ code, message }`.
- Unknown throw → `UPSTREAM_ERROR` + “Internal error while running the tool”.

Kode error — salin set, ganti prefix platform:

| Code | HTTP default |
| --- | --- |
| `INVALID_INPUT` | 400 |
| `UNAUTHORIZED` / `<P>_AUTH_EXPIRED` | 401 |
| `FORBIDDEN` / `MUTATION_DISABLED` | 403 |
| `UNSUPPORTED_OPERATION` | 404 |
| `APPROVAL_REQUIRED` | 409 |
| `RESULT_LIMIT_EXCEEDED` | 413 |
| `<P>_RATE_LIMITED` | 429 |
| `UPSTREAM_TIMEOUT` | 504 |
| `UPSTREAM_ERROR` / `HOST_NOT_ALLOWED` / `REDIRECT_NOT_ALLOWED` | 502 |

`AppError.toJSON()` boleh berisi `details` **internal**. `errorResult` **membuang** details.

## 6.4 Resources

| URI | Isi |
| --- | --- |
| `<p>://docs/index` | Daftar dokumen |
| `<p>://docs/{document}` | Markdown, di-sanitize saat baca. Nama di-allowlist; selain itu `ResourceNotFoundError` |
| `<p>://openapi` | OpenAPI 3.1 dari registry |
| `<p>://capabilities` | Payload di bawah |
| `<p>://coverage` | `{ summary, entries }` |

Payload `capabilities` (disesuaikan token **ini**):

```
protocol, tools[], progressiveDiscovery,
operations: { exposed, read, write, destructive },
mutations: { enabled, toolAvailable, approval },
codeMode: { timeoutMs, maxRequests, maxConcurrency, maxResponseChars, maxOutputChars, network },
widgets: { enabled, views, resourceUris }
```

`tools` = yang **benar-benar terdaftar** untuk principal ini.

## 6.5 Prompts

2–5 prompt yang menuntun model:

1. `search` dulu.
2. `execute` halaman kecil.
3. Agregasi di sandbox.
4. Jangan dump katalog.
5. **Jangan** injeksi default outlet/cabang ke prompt `execute` — model harus minta ke user jika operasi butuh id itu.

(Widget tools boleh fallback ke sesi; itu pengecualian yang disengaja.)

Tulis skenario bisnis baru, jangan salin nama prompt lama.

## 6.6 Tes fase 6

- Protocol: `tests/protocol/mcp-wire.test.ts`, `capabilities.test.ts`
- Security: `codemode-request.test.ts` (fetch diblokir, key diselundupkan ditolak, write ditolak, error typed tanpa details), `codemode-dispatcher.test.ts`, `codemode-limits.test.ts`
- Evals offline: `tests/evals/scenarios.test.ts` — skrip bergaya model + dispatcher fixture
- E2E: `scripts/e2e-mcp.ts`

Flag e2e:

```
bun run scripts/e2e-mcp.ts --base http://localhost:8787
bun run scripts/e2e-mcp.ts --base https://mcp.<domain> --live
bun run scripts/e2e-mcp.ts --base http://localhost:8787 --live --connect
```

- Tanpa `--live`: OAuth sungguhan + MCP client 2.0.0 + `tools/list` + `search`, **tanpa** panggilan upstream.
- `--live`: + execute read-only. Juga membuka tiap widget view tool sekali (jika ada) dan validasi `structuredContent` terhadap kontrak — print **bentuk**, jangan nilai.
- `--connect`: login owner lalu capture sesi lewat `/connect` memakai env e2e (bukan secret Worker). Login **bukan** mutasi data.
- Tidak pernah memanggil operasi write/destructive.
- Tidak pernah print secret.
