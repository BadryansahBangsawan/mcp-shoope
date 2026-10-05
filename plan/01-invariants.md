# Invariants

Jika salah satu dilewati, proyek baru **tidak** setara dan tidak boleh dianggap selesai. Ini bukan “nice to have”.

## Model tidak mengemudi jaringan

1. Model **tidak** boleh memilih `method`, `url`, `headers`, host, atau kredensial. `codemode.request()` hanya menerima key `operationId | path | query | body`. Key selundupan ditolak sebelum dispatch.
2. Sandbox Code Mode: `globalOutbound: null`, tanpa binding, tanpa secret, CPU limit isolate. `fetch()` dari skrip model tidak keluar.
3. Operasi harus terdaftar (`exposed`) dan lolos schema **sebelum** `fetch`.
4. Host allowlist https-only, tanpa userinfo, port 443 saja, tanpa `..` / `//` di path. Host diresolve dari `operation.host` + slug config, bukan dari input.
5. Redirect: `manual`. GET same-host saja, max 3 hop. Non-GET 3xx **tidak** diikuti (tulis mungkin sudah terjadi — jangan retry buta). Cross-host tidak diikuti (kredensial tidak pindah).

## Auth klien MCP

6. Token OAuth hanya keluar dari `/authorize` yang butuh **owner password** (≥ 16) + CSRF double-submit. Consent menampilkan nama klien yang diklaim sendiri, client id, dan **origin redirect**. Deny = `access_denied`.
7. Error OAuth / CIMD dirender **lokal**. Jangan auto-redirect error ke `redirect_uri` yang belum divalidasi (open redirector).
8. `authInfo.token` yang diteruskan ke MCP handler = `"redacted"`.
9. `DEV_PSK` hanya jika `ALLOW_DEV_PSK=true` **dan** host loopback `{localhost, 127.0.0.1, [::1]}` **dan** PSK ≥ 16. Grant read+write, bukan admin. Produksi: flag false, secret tidak ada.

## Sesi upstream

10. Sesi AES-256-GCM + AAD. `REQUIRE_SESSION_ENCRYPTION=true`. Record yang gagal didekripsi di-drop, bukan di-return plaintext.
11. Origin tenant **selalu** dari config Worker, tidak dari body login, HTML, atau input model.
12. PIN / password langkah tengah **tidak** disimpan di `pending_auth`. Pending TTL 10 menit + alarm.
13. `markExpired(failedToken?)` compare-and-delete di dalam DO. Jangan hapus sesi baru yang disimpan selama request gagal.
14. Jangan expire sesi pada 403 (role) atau 429 (rate). 419 cookie/CSRF ≠ Bearer mati.

## Output dan log

15. Error ke model: `{ code, message }` saja. Tidak ada stack, `details`, cookie, token, PIN.
16. Log: redaksi key sensitif + pola token. Username = panjang saja. Token = 4 karakter prefix. Log tool error = kode saja, bukan message.
17. OpenAPI / catalog / docs resource **tanpa** example PII dan tanpa kredensial. Sanitize saat **baca** resource, bukan hanya saat bundle.

## Mutasi

18. Empat gerbang (flag + scope write/admin + safety class terdaftar + approval sekali pakai). Safety = **efek**, bukan HTTP verb.
19. `preflight` sebelum `consume`. Klien MCP tidak bisa approve — hanya owner di browser + CSRF.
20. E2E tidak pernah memanggil operasi write/destructive.

## Widget

21. Iframe tidak boleh `fetch` sendiri (`connect-src 'none'`). Semua data lewat `tools/call` host.
22. Tidak ada `localStorage` / cookie / `<form>` / `dangerouslySetInnerHTML` di SPA. Link hanya lewat `host.openLink`.
23. Setiap widget tool: cek scope di handler, hanya `operationId` hardcoded, tidak ada `allowMutation`, tes keamanan per tool.
24. Visibility helper adalah kosmetik. Anggap seaman `execute`.
25. `ENABLE_WIDGETS=false` menghapus tools **dan** resource `ui://`.

## Operasional

26. Satu Worker = satu tenant. Jangan biarkan client pilih origin/slug.
27. `workers_dev: false`, `preview_urls: false` — audience OAuth harus stabil. Custom domain, bukan `*.workers.dev`.
28. Jangan edit `vars` hanya di dashboard Cloudflare — deploy berikutnya menimpa. Edit `wrangler.jsonc`.
29. Jangan edit tag migration DO yang sudah di-deploy. Class baru = tag baru.
30. Hop login yang tidak didukung dijawab **410** + pesan jelas, bukan 404 diam-diam, dan tidak di-expose ke catalog `search`. Pemilih tenant = 410 (origin dari config). OTP verify/resend = 410 sampai ada desain yang tidak menyimpan kode.
31. Metadata OAuth wajib: RFC 7591 DCR, RFC 9728 resource (root **dan** `/mcp`), RFC 8414 AS. `GET /` menunjuk path-appended `/mcp`.
32. View tool ChatGPT: `openai/widgetAccessible: true` + URI di `openai/outputTemplate`. Tanpa itu iframe tidak boleh `callTool`.
