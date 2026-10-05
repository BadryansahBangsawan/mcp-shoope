# Address

Baca daftar alamat. Evidence: `observed`. Ubah/hapus/tambah = exclusions.

Target: `address.list`.

`GET https://shopee.co.id/api/v4/account/address/get_user_address_list`

Query (opsional): `with_warehouse_whitelist_status`.

Jangan dump nama, telepon, alamat lengkap kecuali user secara eksplisit minta untuk akun miliknya.
