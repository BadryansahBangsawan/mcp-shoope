# Fase 3 — registry operasi

Ini jantungnya. Model tidak “tahu API”; ia membaca catalog yang Anda daftarkan.

## 3.1 Tipe (`src/registry/types.ts`)

Setiap `ApiOperation` wajib punya:

```
operationId, title, description, method, host, pathTemplate,
sourceDocument, evidence, authProfile, responseKind, safety,
tags, inputSchema, exposed
```

Opsional: `outputSchema`. Ganti `HostKey` sesuai allowlist platform Anda.

| Field | Enum |
| --- | --- |
| `method` | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `evidence` | `observed` `documented-not-executed` `inferred` `empty-response` `failed-probe` `unknown` |
| `authProfile` | `bearer` `raw-token` `cookie-csrf` `www-csrf` `none` |
| `responseKind` | `json` `html` |
| `safety` | `read` `write` `destructive` |
| `CoverageStatus` | `implemented` `html-adapter` `mutation-gated` `session-only` `excluded` |

Aturan:

- `safety` berdasarkan **efek**, bukan HTTP verb. GET yang membatalkan order = `destructive`.
- `exposed: false` untuk hop login / helper sesi (mereka masuk `SESSION_ONLY`, bukan catalog).
- `inputSchema`: JSON Schema subset, `type: "object"`, `additionalProperties: false`.
- Page-size keys `count` / `limit` / `per_page`: integer, maximum ≤ **100** (validator juga cap 100 jika schema tidak menyebut maximum).
- `page` (dan page-size keys) minimum **1**.
- String di wire default `maxLength` **2000** jika schema tidak menyebut `maxLength`.
- Setiap `{param}` di `pathTemplate` wajib ada di `inputSchema.properties` **dan** `required`.
- Exposed ops **tidak boleh** evidence `failed-probe` atau `unknown`.

Helper: `op()`, `MAX_PAGE_SIZE = 100`, `pageParam`, `countParam`, `pageCount`, `dateRange`.

## 3.2 File operasi

Pecah per domain (`ops/catalog.ts`, `ops/reports.ts`, `ops/misc.ts`, …). Aggregator mengekspor:

- `getOperation(id)`
- `listExposedOperations()` — `exposed === true`
- `listReadOperations()`
- `listMutationOperations()`

`operationId` memakai dotted names yang stabil: `products.list`, `reports.summaries.sales`. **Jangan ganti id** setelah klien mulai menulis skrip.

`description` harus memuat jebakan yang diamati.

## 3.3 Validasi input (`src/registry/validate.ts`)

Salin utuh dari repo acuan. Perilaku yang tidak boleh hilang:

- Kumpulkan **semua** missing / unknown / invalid, lalu lempar sekali (`INVALID_INPUT`) agar model memperbaiki sekaligus.
- Path param dari template `{id}` saja.
- Segmen path string: `^[A-Za-z0-9_-]{1,64}$`.
- Segmen path integer: `^\d{1,20}$` (non-negatif).
- GET/DELETE → sisa property = query. POST/PUT/PATCH → body.
- Toleransi path-in-query jika nilainya **sama**; tolak jika berbeda.
- Query value: string / number / boolean. Bukan objek.

## 3.4 OpenAPI + catalog Code Mode

Bangun OpenAPI **3.1.0** dari operasi **exposed** saja:

- Satu `servers: [{ url }]` per operasi (host berbeda = server berbeda).
- **Tidak** copy `example` / `default` dari capture (PII).
- Tanpa kredensial di document.
- Vendor extension boleh — ganti prefix.
- Collision: `method + pathTemplate` yang sama di dua host **melempar** (kunci path OpenAPI tidak punya host). Pecah path di spec jika platform Anda punya kasus itu.

Catalog entry per operasi untuk `codemode.spec()`:

```
{ operationId, title, description, method, host, path, safety,
  auth, responseKind, tags, evidence, sourceDocument, inputKeys }
```

## 3.5 Coverage (wajib, bukan hiasan)

Tiga file + dua script:

- `src/registry/doc-endpoints.ts` — parser markdown → daftar `METHOD + host + path`. **Tulis ulang** sesuai gaya dokumen.
- `src/registry/exclusions.ts` — `SESSION_ONLY` + `EXCLUSIONS` dengan alasan.
- `src/registry/coverage.ts` + `checks.ts` — setiap endpoint dokumen = tepat satu baris manifest; id tidak tabrakan; failed-probe tidak `exposed`; file impl/test yang dirujuk ada.
- `scripts/validate-coverage.ts`, `scripts/validate-openapi.ts`
- `scripts/bundle-docs.ts` mengompilasi `docs/<API_DOC_NAMES>.md` → `src/docs/bundled.ts`

Status otomatis untuk operasi exposed:

| Kondisi | `status` |
| --- | --- |
| `safety !== "read"` | `mutation-gated` |
| `responseKind === "html"` + ada mapping adapter | `html-adapter` |
| selain itu | `implemented` |

HTML tanpa mapping adapter → **throw saat build manifest**.

Baris `SESSION_ONLY`: `operationId: null`, `exclusionReason` terisi, `implModule` + `testFile` ada. Baris `EXCLUSIONS`: `operationId: null`, alasan terisi, `implModule`/`testFile` null.

Sanitize PII saat **read** resource (`sanitizeDocMarkdown`), bukan saat bundle. Tes `docs-pii.test.ts` gagal jika bundle drift dari `docs/` atau sample PII lolos.

Perintah: `bun run coverage:validate`, `bun run coverage:report`, `bun run docs:bundle`, `bun run openapi:validate`.

Angka coverage repo acuan (skala, **bukan target**): puluhan implemented, sedikit html-adapter, sedikit mutation-gated, beberapa session-only, puluhan excluded. Proyek baru punya angkanya sendiri.
