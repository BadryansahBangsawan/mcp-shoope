# Fase 1 — capture API upstream (sebelum kode MCP)

Tanpa dokumen endpoint yang **diamati**, registry akan mengarang. Kerjakan ini dulu. Jangan tulis `ops/*.ts` dari tebakan.

## 1.1 Cara capture

1. Login ke dashboard / app platform target di browser biasa (akun milik Anda / tenant yang mengotorisasi).
2. DevTools → Network. Filter XHR/fetch.
3. Lakukan setiap aksi bisnis yang ingin dilayani MCP: list, detail, filter tanggal, paging, search.
4. Untuk tiap request yang berguna, simpan:
   - method, host, path (template `{id}`), query, body
   - header yang **wajib** (Authorization bentuk apa, CSRF nama header, Origin, Cookie, `X-Requested-With`)
   - status + cuplikan JSON (PII disamarkan: nama, telepon, email, alamat → placeholder)
   - paging: nama field (`page`/`count` vs `cursor`), apakah `count` dihormati, apakah filter benar-benar memfilter
   - jebakan: parameter yang 500, yang diabaikan, yang mengubah format respons
5. Halaman SSR tanpa JSON: simpan HTML fixture. Nanti jadi HTML adapter, atau `excluded` jika tidak layak.
6. Sengaja picu 401, 403, 419/CSRF-expired, dan HTML login (bukan JSON) supaya dispatcher tahu cara memetakan expire vs forbidden.

## 1.2 Format dokumen wajib

Satu file markdown per domain, di `docs/<topik>.md`:

```markdown
# <Platform> <Topik>

Satu kalimat apa adanya. Bukan spekulasi.

Captured from <origin> → <api host>.

## Endpoint
METHOD https://host/path

## Query / Path / Body
Tabel: nama, tipe, required, contoh, catatan (termasuk "jangan kirim X, 500").

## Headers
Tabel: authorization bentuk apa, csrf, origin, cookie.

## Example request
curl dengan <TOKEN> / <CSRF_TOKEN>, bukan nilai asli.

## Response
Envelope + field penting + arti id (mana yang dipakai endpoint lain).

## Related endpoints
Link ke dokumen lain.

## Evidence
observed | documented-not-executed | failed-probe | empty-response
```

Dokumen login terpisah: setiap hop (halaman sign-in, POST kredensial, pilih tenant, pilih outlet/cabang, OTP, redirect, scrape token). Tandai hop mana yang **akan didukung** dan mana yang **ditolak 410**.

Aturan:

- Jangan commit token, cookie, PIN, PII asli.
- Setiap `METHOD + host + path` yang tertulis **harus** muncul tepat sekali di coverage manifest nanti (`implemented` / `html-adapter` / `mutation-gated` / `session-only` / `excluded`).
- Probe yang gagal: tulis di dokumen **dan** masukkan `EXCLUSIONS` dengan alasan. Jangan `exposed: true`.
- Jangan expose hop login ke catalog `search`.

## 1.3 Parser coverage vs gaya dokumen

Coverage **tidak** percaya registry. Ia mengekstrak `METHOD + host + path` dari markdown.

**Proyek baru harus menulis parser sesuai gaya dokumen Anda.** Jika dokumen hanya memakai bentuk A (`METHOD https://host/path` di heading), parser boleh sederhana — tapi tes coverage harus gagal jika satu endpoint dokumen tidak masuk manifest.

Kunci manifest:

```
`${METHOD} ${host} ${path.replace(/\{[^}]*\}/g, "{}")}`
```

`{id}` dan `{purchase_id}` dianggap sama. Host berbeda = kunci berbeda.

## 1.4 Kriteria “cukup untuk mulai kode”

Minimal yang harus ter-capture:

- Login (atau cara dapat token resmi)
- 5–15 operasi read yang menjawab pertanyaan bisnis nyata
- Bentuk paging yang konsisten (atau catatan jika tidak)
- Daftar host yang muncul
- Paling tidak satu contoh 401 / 403 / CSRF-expired / login-HTML
- Daftar hop login yang ditolak (OTP, SSO, …)

Widget dan mutasi **boleh ditunda**. Jangan tunda capture read path.

## 1.5 Domain bisnis yang biasanya cukup untuk POS / dashboard toko

Bukan daftar wajib — sesuaikan platform Anda. Yang terbukti berguna:

- Katalog produk + harga + stok
- Ringkasan penjualan per tanggal / outlet
- Ranking produk
- Riwayat transaksi / order
- Pembelian / PO
- Supplier
- Pelanggan + piutang
- Penyesuaian stok / mutasi gudang
- User / kasir (read)

Tulis jebakan di `description` operasi nanti, contoh pola yang baik:

```
"Paginated merchant product catalog. Do not send outlet_ids (500). name= does not filter."
```

Tanpa catatan itu, model akan mengirim parameter yang merusak.
