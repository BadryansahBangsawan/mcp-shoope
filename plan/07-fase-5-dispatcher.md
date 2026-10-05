# Fase 5 — dispatcher

Satu kelas: `<Platform>Dispatcher`. **Satu-satunya** tempat `fetch` ke upstream untuk tool (Code Mode, widget, mutasi). Bind `fetch` sebagai `(input, init) => fetch(input, init)`.

## 5.1 Limit

| Limit | Nilai |
| --- | --- |
| Timeout wall-clock (termasuk redirect + baca body) | **25_000 ms** |
| Body cap (stream, jangan `text()` dulu) | **2_000_000** byte |
| Max redirect GET same-host | **3** |

## 5.2 Alur `dispatch({ operationId, path, query, body })`

1. `getOperation` — harus ada dan `exposed`. Selain itu `UNSUPPORTED_OPERATION`.
2. Jika `safety !== "read"`: butuh `mutationsEnabled` **dan** `opts.allowMutation === true`. Selain itu `MUTATION_DISABLED` (pesan beda: flag mati vs harus lewat `execute_mutation`).
3. `validateOperationInput`.
4. `sessions.getSession()`.
5. `resolveHost(op.host, slug)` — slug dari sesi/config, bukan input. Slug: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
6. `buildPath(template, path)` + `resolveUrl` (parser URL **tidak boleh** mengubah pathname — assert setelah `new URL`).
7. `applyQuery` (drop `undefined`).
8. `assertAllowedUrl`: https, no userinfo, port 443 saja, hostname ∈ allowlist, no `..` / `//`.
9. Header dari `authProfile` + Origin/Referer **trusted** (origin tenant). Jangan teruskan header dari model.
10. `fetch` `redirect: "manual"`.
11. Map status.
12. JSON parse, atau HTML adapter.

`preflight()` = langkah 1–9 tanpa `fetch`. Dipakai `execute_mutation` **sebelum** `consume` approval.

## 5.3 `authProfile` → header (pola, bukan nilai platform acuan)

Tulis ulang `buildHeaders` sesuai capture Anda.

| Profile | Yang dikirim |
| --- | --- |
| `bearer` | `Authorization: Bearer <token>` |
| `raw-token` | `Authorization: <token>` apa adanya |
| `cookie-csrf` | `Cookie` + header CSRF + `X-Requested-With` hanya jika JSON |
| `www-csrf` | cookie www + CSRF dari meta/halaman www |
| `none` | tidak ada kredensial |

Origin/Referer selalu dari origin tenant yang di-config.

## 5.4 Map status upstream

| Upstream | Error tool | Sesi |
| --- | --- | --- |
| 401 | `<PLATFORM>_AUTH_EXPIRED` | hapus hanya jika `authProfile` adalah `bearer` atau `raw-token` **dan** token masih sama |
| Redirect ke URL login | `<PLATFORM>_AUTH_EXPIRED` | sama aturan expire |
| 419 / CSRF page expired | `<PLATFORM>_AUTH_EXPIRED` | **tetap** (Bearer mungkin masih hidup) |
| HTML login padahal JSON diharapkan | `<PLATFORM>_AUTH_EXPIRED` | tetap |
| 403 | `FORBIDDEN` | tetap (role/outlet, bukan expire) |
| 429 | `<PLATFORM>_RATE_LIMITED` | tetap |
| 4xx/5xx JSON | `UPSTREAM_ERROR` (message = status saja; `details` tidak ke klien) | tetap |

## 5.5 Redirect (`src/dispatcher/upstream.ts`)

Salin utuh, ganti deteksi URL login.

- Ikuti hanya GET, same host, allowlist, max 3 hop.
- Sign-in URL → `kind: "login-redirect"`, jangan diikuti.
- Non-GET + 3xx → `REDIRECT_NOT_ALLOWED` + peringatan “write mungkin sudah terjadi, jangan retry buta”.
- Cross-host → `REDIRECT_NOT_ALLOWED`.
- Satu `AbortSignal.timeout` untuk seluruh hop + baca body; di-`AbortSignal.any` dengan signal pemanggil (deadline Code Mode / widget).

## 5.6 HTML adapter

Wajib `assertExpectedPage(html, markers, pageName)`:

- Marker halaman ada → parse.
- `looksLikeLoginPage` → `<PLATFORM>_AUTH_EXPIRED`.
- Selain itu → `UPSTREAM_ERROR` “page marker not found”.
- **Jangan** “sukses 0 baris” untuk halaman yang salah.

`looksLikeLoginPage` harus ditulis ulang dari HTML login platform Anda. Helper tabel (`extractTables`, `cellText`, `decodeEntities`, `readPagination`) boleh di-copy.

Paging HTML: jangan percaya `total_page` jika tidak terbukti. Pakai `rel=next` / panjang halaman.

## 5.7 Tes

`dispatcher.test.ts`, `dispatcher-transport.test.ts`, `allowlist.test.ts`, `html-adapters.test.ts`.
