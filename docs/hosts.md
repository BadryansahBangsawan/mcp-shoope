# Hosts

Allowlist tertutup. Model tidak pernah memilih host. Dispatcher `assertAllowedUrl` hanya https, port 443, tanpa userinfo, tanpa `..` / `//`.

## Produksi

- `shopee.co.id` — web buyer Indonesia. HostKey `www`.

Host lain (mall, chat) **hanya** setelah capture dan masuk `HOSTS`.

Cookie jar boleh menyimpan `*.shopee.co.id` dari paste; fetch dispatcher v1 hanya ke `shopee.co.id`.

## Bukan allowlist

- Seller Centre
- Host Open Platform / partner
- `workers.dev` (Worker memakai custom domain `mcp.shopee.badry.engineer`)
- Microsoft / Google / Facebook (cookie pihak ketiga di-drop saat paste)

Connect Worker (`/connect`, `/login`) bukan upstream; parser coverage tidak mengekstrak domain ini.
