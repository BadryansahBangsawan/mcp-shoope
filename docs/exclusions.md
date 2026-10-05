# Exclusions

v1 adalah **baca akun sendiri**. Mutasi default OFF.

## Di luar produk

- Checkout, pilih kurir, bayar, ShopeePay send
- Tulis keranjang, ubah/hapus/tambah alamat
- Kirim chat, follow toko, like, klaim voucher
- Cari marketplace / scrape katalog toko orang
- Seller Centre (HTML login toko) dan ChatEasy di host seller
- Open Platform (HMAC, `shop_id`, `access_token` / `refresh_token`)
- SSO Google / Facebook / Apple sebagai hop Worker
- Autobuy, mass scrape, akun orang lain

## Ter-capture lalu excluded

`POST https://shopee.co.id/api/v4/cart/update`

Tulis keranjang (quantity / select / checkout prep). Bukan operasi Code Mode.

## Yang menunggu capture

Chat (read) — XHR ada di host seller, belum di-allowlist. Jangan tulis METHOD URL seller.

`ENABLE_MUTATIONS` tetap `false`. Jangan nyalakan tanpa XHR write + approval UI + tes.
