# Notifications

Notifikasi akun. Evidence: `observed`.

Target: `notifications.list`, `notifications.activities`.

`GET https://shopee.co.id/api/v4/notification/get_notifications`

Query (opsional): `action_cate`, `limit`.

`GET https://shopee.co.id/api/v4/notification/get_activities`

Query (opsional): `limit`. Feed kosong (`data` kosong, HTTP 200) adalah observed yang valid; jangan invent hop.

Jangan tandai-dibaca / hapus (mutasi).
