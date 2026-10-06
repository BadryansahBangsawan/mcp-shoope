# Shopee MCP — arsitektur

Remote MCP untuk **satu akun buyer** di `shopee.co.id`. Bukan toko seller. Bukan Open Platform. Model tidak pernah memilih `method` / `url` / `headers` / host / kredensial.

```
Klien MCP --Bearer--> Worker https://mcp.shopee.badry.engineer/mcp
                         search / execute → Code Mode isolate (globalOutbound:null)
                         └── ShopeeDispatcher (satu-satunya fetch)
                               Cookie + CSRF dari DO (AES-GCM)
                               host allowlist shopee.co.id
                   /connect        form login HP/email
                   POST /connect/login  → Worker POST login
                   POST /connect/otp    → Worker POST OTP
                   POST /connect/paste  → fallback cookie JSON
```

## Keputusan terkunci

| Pertanyaan | Keputusan |
| --- | --- |
| Siapa | Satu akun buyer operator |
| API | XHR web `shopee.co.id` (region ID) |
| Auth upstream | `cookie-csrf` |
| Host | `shopee.co.id` (HostKey `www`) |
| Tenant | Satu Worker = satu jar |
| Login | Form `/connect` + OTP. Paste = cadangan. SSO / Open Platform = 410 |
| Mutasi | `ENABLE_MUTATIONS=false` |
| Widget | `ENABLE_WIDGETS=false` |
| Bahasa | Indonesia (UI owner + deskripsi tool) |
| Zona | `Asia/Jakarta` |
| Domain | `https://mcp.shopee.badry.engineer` |
| OAuth resource | `Shopee MCP` |

## Tool

Hanya `search` dan `execute`. `execute_mutation` tidak terdaftar di v1. Resources: `shopee://docs|openapi|capabilities|coverage`. Prompts: `riwayat-beli`, `detail-pesanan`, `ringkas-akun`.

Katalog v1: **12** operasi baca `observed` (profil, pesanan, keranjang, alamat, voucher, notifikasi, koin). Chat skip — host `seller.shopee.co.id` tidak di-allowlist. Manifest: `docs/architecture/coverage.md`. GET `/mcp` tanpa Bearer = 401 (OAuth). Connect harus di host produksi; deploy tidak menyalin jar lokal.

