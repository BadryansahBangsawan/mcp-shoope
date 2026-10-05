# Anti-pola

Yang terlihat “lebih cepat” tapi merusak. Jika Anda tergoda salah satu, baca lagi [01-invariants.md](01-invariants.md).

1. **Satu tool MCP per REST endpoint.** `tools/list` membengkak; model salah pilih; Anda mengulang validasi. Pakai registry + `execute`.
2. **`fetch` dari dalam sandbox.** Langsung SSRF dan bocornya cookie. `globalOutbound: null` bukan opsional.
3. **Host / URL / method / headers dari argumen model.** Allowlist dari registry saja. Tes selundupan di `codemode-request.test.ts` wajib porting.
4. **Ikuti redirect 307 pada POST.** Mutasi bisa replay atau hilang. Tolak + peringatkan.
5. **Expose hop login ke `search`.** `session-only` / `exposed: false`.
6. **Hidupkan mutasi tanpa halaman approval.** Flag saja tidak cukup. Empat gerbang.
7. **Widget `fetch` ke API Anda.** CSP host akan memblokir, atau lebih buruk: cookie terpapar di iframe. Semua lewat `tools/call`.
8. **Masukkan contoh PII di docs/OpenAPI.** Tes PII harus gagal.
9. **`workers.dev` sebagai URL MCP.** Audience OAuth pecah tiap preview.
10. **Ubah `vars` hanya di dashboard.** Deploy berikutnya menimpa. Edit `wrangler.jsonc`.
11. **Edit migration DO `v1` setelah deploy.** Tambah tag baru.
12. **OTP “nanti kita dukung” tanpa desain.** Tolak eksplisit (410) sampai ada alur yang tidak menyimpan kode OTP di log/DO.
13. **Percaya `total_page` / `total_result` upstream.** Banyak API berbohong; pakai `next` / panjang halaman.
14. **Return envelope mentah ke model.** Pilih field; cap ukuran; agregasi di sandbox.
15. **HTML adapter yang menganggap halaman salah = 0 baris.** Wajib `assertExpectedPage`.
16. **Expire sesi pada 403/429/419 cookie.** 403 = role; 429 = rate; 419 cookie ≠ Bearer mati.
17. **`markExpired()` tanpa compare-and-delete.** Race: sesi baru yang disimpan selama request gagal ikut terhapus.
18. **Import `ext-apps` di Worker.** Bundle membengkak + coupling. Inline konstanta.
19. **Pakai `codeMcpServer()` / `openApiMcpServer()` / `McpAgent`.** SDK v1, bukan arsitektur ini.
20. **CSRF 1 jam / DCR client 90 hari.** Kode yang jalan: CSRF **8 jam**, DCR client **365 hari**. Jangan meniru docs yang salah.
21. **DEV_PSK grant admin, atau hidup di produksi.** Read+write, loopback, flag terpisah.
22. **Injeksi default outlet ke prompt `execute`.** Model harus bertanya. Widget boleh fallback ke sesi.
23. **Log token / PIN / password / username.** Prefix 4 karakter dan `usernameLen` saja.
24. **`authInfo.token` = access token asli.** Redacted.
25. **Auto-redirect error OAuth ke `redirect_uri` klien DCR.** Open redirector. Render error lokal.
26. **Fork + search-replace nama produk.** Sisa host, cookie, HKDF, dan hop login lama. Scaffolding bersih + tabel pengganti di fase 0.
27. **Coverage yang percaya registry.** Parser harus membaca dokumen. Manifest 1:1 dengan `METHOD + host + path`.
28. **Widget tanpa teks fallback.** Klien tanpa MCP Apps tetap harus dapat jawaban.
29. **Iframe widget `sandbox` dengan `allow-forms`.** Enter di input akan submit dan pecah. Hanya `allow-scripts`.
30. **`window.history` di SPA widget.** Pakai `createMemoryHistory`.
31. **View tool tanpa `openai/widgetAccessible: true`.** ChatGPT menolak `callTool` dari iframe (default false).
32. **Anggap `ENABLE_WIDGETS` default mati.** Kode: hidup kecuali string `"false"`. Kill switch harus eksplisit.
