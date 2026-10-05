# Kartu konstanta

Nilai tanpa ★ = salin angka. Nilai ★ = ganti identitas, jangan salin string platform lama.

## Protocol & dependency

| Item | Nilai |
| --- | --- |
| Protocol MCP | `2026-07-28` |
| SDK server/client | `2.0.0` exact |
| agents | `0.23.0` |
| workers-oauth-provider | `0.10.3` exact |
| codemode | `0.5.2` |
| ext-apps (dev, SPA only) | `2.0.0` exact |
| compatibility_date | `2026-09-15` |
| flags | `nodejs_compat`, `global_fetch_strictly_public` |

## OAuth

| Item | Nilai |
| --- | --- |
| Access token TTL | 3600 s |
| Refresh token TTL | 180 hari |
| DCR client TTL | 365 hari |
| DCR redirect URIs | ≤ 5, tiap ≤ 512 |
| DCR client_name | ≤ 100 |
| DCR metadata JSON | ≤ 8192 |
| Audience | `${PUBLIC_BASE_URL}/mcp` |
| DCR | RFC 7591 `POST /oauth/register` |
| Resource metadata | RFC 9728 `/.well-known/oauth-protected-resource` **dan** `/mcp` |
| AS metadata | RFC 8414 `/.well-known/oauth-authorization-server` |
| Klien publik | `tokenEndpointAuthMethod: "none"` (PKCE S256) |
| Resource `scopes_supported` | **read saja** |
| ★ Scope strings | `<platform>:read/write/admin` |

## Owner

| Item | Nilai |
| --- | --- |
| Owner password | ≥ 16 |
| Owner cookie TTL | 8 jam |
| CSRF cookie TTL | 8 jam (**bukan 1 jam**) |
| CSRF token | 32 hex |
| Password failures | 10 / 15 min / IP (/64), tanpa bucket global |
| DEV_PSK | ≥ 16, loopback, read+write (bukan admin) |
| ★ Cookie names | ganti prefix owner / csrf |
| ★ HKDF cookie info | string unik |

## Code Mode

| Item | Nilai |
| --- | --- |
| Code input | 1–20_000 chars |
| Timeout / CPU | 30 s / 10 s |
| Requests / concurrency | 50 / 4 |
| Response / sandbox result | 5e6 / 1e6 chars |
| Spec calls | 20 |
| Output | 6000 token ≈ 24 KB |

## Dispatcher & registry

| Item | Nilai |
| --- | --- |
| Dispatcher timeout / body / redirects | 25 s / 2 MB / 3 |
| Page size registry | max 100 |
| Wire string default | max 2000 |
| Path segment | `[A-Za-z0-9_-]{1,64}` |
| Path integer | `^\d{1,20}$` |

## Sesi & mutasi

| Item | Nilai |
| --- | --- |
| Pending auth TTL | 10 min |
| Approval TTL | 10 min |
| Cookie jar | max 64, value ≤ 4096 |
| Paste cookie | ≤ 8192 printable ASCII |
| Login fetch timeout / hops | 15 s / 3 |
| PIN window (jika ada) | 15 min; 10/IP, 6/user, 20 global |
| ★ HKDF session salt/info | ganti kedua label |
| ★ Error prefix | `<PLATFORM>_AUTH_EXPIRED` / `_RATE_LIMITED` |
| ★ DO class / binding | ganti nama sesi |

## Widget

| Item | Nilai |
| --- | --- |
| Widget resource TTL | 600_000 ms |
| Widget structured / text | 250_000 / 2_000 |
| Widget page | 1–500 |
| Widget date range | max 366 hari |
| Widget budget | 4 concurrent, 30 s, 8e6 chars |
| Query SPA | stale 60 s / gc 600 s / retry 1 |
| `toolinput` wait | ≤ 1 s, late apply ≤ 90 s |
| Default flag | hidup kecuali `ENABLE_WIDGETS==="false"` |
| ★ Widget URI | `ui://<brand>/<view>.html` |
| ★ View marker | `__<BRAND>_VIEW__` |

CSP iframe widget (host, jika resource tanpa domain):

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; media-src 'self' data:; connect-src 'none'
```

Sandbox: `allow-scripts` saja, **tanpa** `allow-forms`.

## HTML owner

```
content-type: text/html; charset=utf-8
cache-control: no-store
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: no-referrer
strict-transport-security: max-age=31536000
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'
```

Jangan set `form-action`.
