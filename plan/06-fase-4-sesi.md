# Fase 4 — sesi upstream + Connect

Ada **dua jalur**. Pilih di fase 0.

## 4.1 Jalur A — platform punya API key resmi

Sederhana:

- Secret Worker: `API_TOKEN` (dan apa pun yang wajib: CSRF, cookie, …).
- `StaticXxxSessionProvider.getSession()` membaca secret. Gagal konfigurasi → `<PLATFORM>_AUTH_EXPIRED`.
- `markExpired(failedToken?)` menandai request berikutnya expired sampai operator rotasi secret.
- **Tetap** enkripsi jika Anda menyimpan apa pun di DO.
- Origin selalu dari config.
- Skip UI `/connect` login, atau buat halaman “paste API key” owner-only.

Jangan log token. Jangan masukkan key ke resource MCP.

## 4.2 Jalur B — dashboard session

Wajib meniru pola `src/session/*` + `src/connect/*`, **bukan** hop login platform acuan.

### Durable Object

Satu instance per tenant: `idFromName("merchant:<SLUG>")`. Class SQLite, migration `v1`.

| Key | Isi | Catatan |
| --- | --- | --- |
| `session` | token + csrf + cookie jar + outlet/branch + `connectedAt` + subject | AES-GCM v2 + AAD |
| `pending_auth` | state langkah tengah (pilih outlet, …) **tanpa PIN** | TTL **10 menit**, alarm hapus. `exp` **plaintext** supaya TTL bisa di-sweep tanpa kunci |
| `device_id` | UUID | **Plaintext**. Selamat dari `clear()` / disconnect supaya reconnect terlihat perangkat yang sama |
| `rate:<sha256>` | `{ count, resetAt }` | Key di-hash, bukan username/IP mentah |

`markExpired(failedApiToken?)`:

- Tanpa argumen: clear semua (legacy).
- Dengan token: **compare-and-delete** di dalam DO (hash SHA-256). Sesi yang baru disimpan *selama* request gagal **tetap hidup**. Secret statis hanya ditandai expired jika masih memegang token itu.

Provider komposit:

1. Coba DO.
2. Jika kosong / token+csrf tidak lengkap, fallback secret bootstrap.
3. Origin merchant **selalu** dari slug config, tidak dari record tersimpan.

### Kripto

Salin algoritma, **ganti label**.

| Item | Nilai |
| --- | --- |
| Algo | AES-256-GCM |
| IV | 12 byte |
| HKDF salt / info | string unik proyek (jangan salin label lama) |
| Key | `SESSION_ENCRYPTION_KEY`: base64 32-byte **preferred** (`openssl rand -base64 32`); selain itu diperlakukan passphrase UTF-8 |
| AAD | mengikat storage key + kind + expiry |
| v1 legacy | blob tanpa AAD, read-only — boleh dihapus jika tidak ada data lama |
| `REQUIRE_SESSION_ENCRYPTION=true` | menolak plaintext baca **dan** tulis |
| Gagal dekripsi | hapus record + log `session.record_dropped` tanpa isi |

Cookie HMAC owner memakai `SESSION_ENCRYPTION_KEY` yang **sama** sebagai root, dengan salt/info **berbeda**. Rotasi salah satu dari `OWNER_PASSWORD` / `SESSION_ENCRYPTION_KEY` mematikan semua cookie owner. Rotasi **tidak** mencabut grant OAuth (itu di KV).

## 4.3 Connect UI — tabel rute

Gate: cookie owner **atau** header `x-dev-psk` di loopback. Form butuh CSRF; `x-dev-psk` CSRF-exempt.

GET tanpa identity → 302 `/login?next=…` (HTML) atau 401 JSON.

Nama hop di bawah adalah **pola**. Ganti path langkah-tengah sesuai capture Anda; yang wajib ditiru adalah pemisahan 410 vs 404.

| Method + path | Isi |
| --- | --- |
| `GET /connect` | Form login, atau halaman pending jika ada state |
| `GET /connect/status` | `{ connected, slug, outlet, connectedAt, source, tokenPrefix }` — **tanpa** secret |
| `POST /connect/login` | CSRF + jalankan flow yang **didokumentasikan**. Log `usernameLen`, bukan username. PIN hanya hidup di memori **satu request HTTP** |
| `POST /connect/<langkah-tengah>` | Contoh: pilih outlet/cabang. Wajib pending; minta rahasia lagi (PIN/password **tidak** disimpan di pending) |
| `any /connect/<pemilih-tenant>` | **410** — origin tenant dari config, jangan biarkan owner pilih slug lain |
| `any /connect/verify-otp`, `/connect/resend-otp` | **410** — OTP tidak didukung sampai ada alur yang tidak menyimpan kode di log/DO |
| Hop tidak didukung lain (SSO, …) | **410** + pesan jelas. Jangan 404 diam-diam |
| `POST /connect/cancel` | CSRF; hapus pending |
| `POST /connect/paste` | CSRF; validasi bentuk token/cookie; `saveSession` |
| `POST /connect/disconnect` | CSRF; hapus sesi + pending; **device id tetap** |
| selain itu di bawah `/connect` | 404 `no-store` |

Gagal di langkah login juga `clearPending()` (`withPendingCleanup`). `saveSession` **selalu** menghapus pending.

## 4.4 Rate limit kredensial platform

Terpisah dari owner password. Jendela **15 menit**, key di-hash SHA-256.

| Bucket | Limit acuan | Catatan |
| --- | --- | --- |
| per IP | 10 | |
| per username ternormalisasi | 6 | |
| global | 20 | Ada global jika rahasia pendek (mis. PIN 6 digit). API key resmi biasanya **tidak** perlu global |

## 4.5 Login server-side

- Cookie jar RFC 6265 subset: max **64** cookie, value ≤ **4096**, hanya domain platform. Jangan kirim cookie host A ke host B kecuali `Domain=.platform`.
- Fetch timeout login **15 s**. Max hop dashboard **3**.
- Redirect hanya https, tanpa userinfo, port 443, hostname allowlist. Landing host setelah login **harus** sama dengan tenant yang dikonfigurasi (bukan tenant lain dari HTML).
- Scrape token dari HTML/JS **best-effort**. Jika gagal → `needs_paste`, **jangan invent** endpoint mint token.
- PIN/password langkah tengah: minta ulang, jangan simpan di `pending_auth`. Hidup di `AuthContext` in-memory **satu request** saja.
- Gagal di tengah: `clearPending()` supaya state tidak menggantung.

Paste: **tulis ulang** sesuai bentuk token Anda. Aturan cookie paste yang boleh disalin: printable ASCII, name=value, ≤ **8192**. Jangan log nilai paste.

## 4.6 Tes

`connect*.test.ts`, `session-crypto.test.ts`, `session-store.test.ts`. Fixture HTML login di `tests/fixtures/`.
