# Fase 7 — widget MCP Apps (opsional)

Hanya jika klien target merender MCP Apps / ChatGPT Apps. Jika tidak: `ENABLE_WIDGETS=false` dan berhenti di sini. Kerjakan **setelah** read path hijau.

## 7.1 Kontrak bersama (`src/widgets/contract.ts`)

File **DOM-free, Worker-free**. Diimpor Worker **dan** SPA. Perubahan harus **aditif** (host boleh cache HTML **10 menit**).

Isi:

- Daftar view + nama tool `show_*` + helper
- URI `ui://<brand>/<view>.html`
- Konstanta MCP Apps **di-inline** (jangan impor `ext-apps` di Worker):

```
MCP_APP_MIME_TYPE                 = "text/html;profile=mcp-app"
MCP_APP_LEGACY_RESOURCE_URI_KEY   = "ui/resourceUri"          // alias datar _meta.ui.resourceUri
OPENAI_OUTPUT_TEMPLATE_KEY        = "openai/outputTemplate"   // alias ChatGPT URI resource
OPENAI_WIDGET_ACCESSIBLE_KEY      = "openai/widgetAccessible" // ChatGPT menolak iframe callTool jika bukan true
OPENAI_VISIBILITY_KEY             = "openai/visibility"       // alias ChatGPT _meta.ui.visibility ["app"]
```

`widgetToolMeta(view)`:

- View: `{ ui: { resourceUri, visibility: ["model","app"] }, "ui/resourceUri": uri, "openai/outputTemplate": uri, "openai/widgetAccessible": true }`
- Helper: `{ ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }`

Resource `ui://` juga set `_meta.ui.prefersBorder: true` dan **tidak** mendeklarasikan domain CSP (host memakai default). HTML di-render saat *read* (ganti marker view) supaya factory tidak menyalin bundle ~700 KB enam kali.

- Marker `data-view` (ganti string lama)
- Zod input/output per tool
- Bound tanggal max **366** hari
- Page widget **1–500** (pager UI, terpisah dari `MAX_PAGE_SIZE=100` di registry)
- Label UI bahasa operator
- `STRUCTURED_MAX_CHARS = 250_000`

Daftarkan tool meskipun klien tidak mengirim UI capability (itu baru diketahui per request, setelah factory).

## 7.2 Definisi tool

Satu helper `registerWidgetTool`:

- Cek scope read di handler.
- `RequestBudget` per panggilan: cap `maxRequests` **per tool** (di-hardcode di definisi), concurrency **4**, timeout **30 s**, response **8_000_000** chars.
- `ctx.request` hanya `operationId` yang di-hardcode di `run()`; assert read; tidak ada `allowMutation`.
- `outletId(input)` = input ?? sesi (baca sesi **maks sekali** per call).
- Teks ≤ **2000** karakter, tanpa nomor telepon.
- `structuredContent` ≤ 250_000 JSON chars.
- ChatGPT kadang drop `structuredContent` → **duplikasi** di `_meta.structuredContent`. Workaround wajib ditiru. SPA meng-unwrap berurutan: `structuredContent` → `structured_content` → `_meta.structuredContent` → `_meta.ui.structuredContent` → nested `.result` (kedalaman ≤ 2).
- Error `AUTH_EXPIRED` menyertakan `connect_url`.
- View tool `_meta`: lihat 7.1 (URI + alias ChatGPT + `widgetAccessible: true`).
- Helper: lihat 7.1 (`visibility: ["app"]` + `openai/visibility=private` + `widgetAccessible: true`).
- `callTool` iframe: coba `App.callServerTool` (ext-apps) dulu, lalu `window.openai.callTool` (ChatGPT).

**Ingat:** visibility helper itu **kosmetik**. Siapa pun pemegang token read tetap bisa memanggil helper.

## 7.3 Proyeksi

Setiap `show_*` memetakan JSON hulu yang berantakan ke bentuk kontrak. Jangan teruskan envelope mentah.

Tangani:

- baris semu / record non-objek (skip)
- `total_result` / `total_page` yang bohong — pakai `next` / panjang halaman
- 404 = “tidak ketemu” bukan 500
- zona waktu bisnis
- truncation ter-flag di `meta.truncated` + `truncated_reason`

Teks bahasa operator harus **menjawab pertanyaan** tanpa UI.

## 7.4 View yang terbukti berguna (POS / toko)

Bukan daftar wajib. Pola: 6 view + ~9 helper paging/detail.

| View | Tool model | Helper app-only | Pertanyaan yang dijawab |
| --- | --- | --- | --- |
| Penjualan | `show_sales_dashboard` | — | Omzet, jumlah transaksi, tren harian |
| Produk | `show_product_ranking` | `product_ranking_page` | Terlaris / omzet tertinggi |
| Stok | `show_stock_browser` | `stock_page`, `stock_history`, `stock_velocity` | Sisa stok, mutasi, perputaran |
| Pembelian | `show_purchase_orders` | `purchase_orders_page`, `purchase_order_items` | PO diproses / selesai / batal |
| Transaksi | `show_transactions` | `transactions_page`, `order_detail` | Daftar order + detail |
| Piutang | `show_customer_debts` | `customer_debt_detail` | Aging, sisa tagihan |

Helper dengan fan-out terbesar butuh cap `maxRequests` yang eksplisit (di acuan, detail piutang ~45). Jangan biarkan satu klik menembak ratusan halaman.

## 7.5 SPA (`widgets/`)

Satu SPA untuk semua view:

- React 19 + TanStack Router / Query / Table / Virtual / Form
- Bridge: `ext-apps` `App.callServerTool`, fallback `window.openai.callTool` (ChatGPT)
- Mock bridge + `?view=` hanya di `widgets:dev`
- Shell: `useApp` (inline + fullscreen) → tunggu ≤ **1 s** host `toolinput` (late apply ≤ **90 s** selama masih default) → prime TanStack Query dari host `toolresult` supaya view tool pembuka **tidak** dipanggil dua kali
- Router: **`createMemoryHistory`** — iframe sandbox tidak boleh menyentuh `window.history`
- Query: `staleTime` 60 s, `gcTime` 600 s, tanpa refetch focus/reconnect, `networkMode: "always"`, retry maksimal 1, **jangan** retry `AUTH_EXPIRED` / `FORBIDDEN` / `INVALID_INPUT` / `RATE_LIMITED` / `CONTRACT_MISMATCH`
- **Nol** request jaringan dari iframe
- Tidak ada `localStorage` / `sessionStorage` / cookie / `<form>` / `dangerouslySetInnerHTML`
- Tombol `type="button"` + key handler (Enter di `<input>` tidak boleh submit)
- Link hanya lewat `host.openLink` / `app.openLink`
- Font sistem saja (`data:` font diblokir)

CSP yang host terapkan jika resource tidak menyebut domain:

```
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' data:;
connect-src 'none'
```

Iframe: `<iframe sandbox="allow-scripts">` — **tanpa** `allow-forms`, origin opaque.

Bundle: `bun run widgets:bundle` → `src/widgets/bundled.ts` (HTML string + source hash). Tes gagal jika hash stale. Sisipkan `<meta name="…-build" content="{hash12}">`. Marker view harus muncul **tepat sekali**. Resource `ui://` mengganti marker saat *read*. `ttlMs` **600_000**. HTML < 1 MB, tanpa data/secret.

Smoke: `bun run widgets:smoke` — Chrome headless, iframe `sandbox="allow-scripts"`, CSP `connect-src 'none'`, AppBridge menjawab `tools/call` dari fixture.

## 7.6 Tes keamanan

`tests/security/widget-tools.test.ts` untuk **setiap** tool:

- tanpa scope → `FORBIDDEN`, 0 dispatch
- hanya operationId yang diizinkan, tidak ada non-read
- input di luar bound ditolak
- hasil tidak mengandung string kredensial

Default **hidup** (`env.ENABLE_WIDGETS !== "false"`). `ENABLE_WIDGETS=false` harus menghapus seluruh permukaan (tools + `ui://`). Kill switch untuk host yang tidak Anda percayai dengan nama pelanggan di `structuredContent`.
