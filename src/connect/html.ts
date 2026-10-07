import type { PendingAuthState } from "../session/types";
import { brandRow, esc, layout } from "../web/html";

function footer(csrfToken: string): string {
  if (!csrfToken) {
    return `<footer class="actions" aria-label="Aksi akun Connect">
  <a class="btn btn-secondary" href="/connect">Kembali ke Connect</a>
</footer>`;
  }
  return `<footer class="actions" aria-label="Aksi akun Connect">
  <a class="btn btn-secondary" href="/connect/status">Status koneksi</a>
  <form method="POST" action="/logout">
    <input type="hidden" name="csrf" value="${esc(csrfToken)}"/>
    <button type="submit" class="btn btn-secondary">Keluar</button>
  </form>
</footer>`;
}

function connectLayout(title: string, csrfToken: string, body: string): string {
  return layout(title, `${body}\n${footer(csrfToken)}`, "shopee-mcp");
}

function qrCard(csrfToken: string, extra = ""): string {
  const csrf = esc(csrfToken);
  return `<section class="card" id="qr" aria-labelledby="qr-title">
  ${brandRow("Koneksi aman")}
  <header class="card-header">
    <h1 id="qr-title">Scan QR Shopee</h1>
    <p class="subtitle">Jalankan <code>bun run auth</code> di mesin ini. Chrome for Testing membuka halaman QR resmi Shopee. Scan di aplikasi Shopee (Scan QR/Barcode → Konfirmasi Log in). Skrip mengirim sesi ke Worker sendiri. Cloudflare Worker tidak menjalankan Chrome dan tidak menampilkan QR.</p>
  </header>
  <div class="panel panel-warning inline-note">
    <span class="status-icon" aria-hidden="true">!</span>
    <span>Tidak ada form di halaman ini. Jangan ketik akun Shopee di Worker. Jangan tempel cookie.</span>
  </div>
  ${extra}
  <ol class="steps">
    <li>Di laptop: <code>bun run auth</code></li>
    <li>Di aplikasi Shopee: Scan QR/Barcode, lalu Konfirmasi Log in</li>
    <li>Tunggu sampai Connect menunjukkan akun terhubung</li>
  </ol>
  <form method="POST" action="/connect/disconnect">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-danger">Putuskan sesi akun</button>
  </form>
</section>`;
}

export function connectLoginPage(opts: { csrfToken: string; statusHtml?: string }): string {
  const status = opts.statusHtml ?? "";
  return connectLayout(
    "Connect Shopee",
    opts.csrfToken,
    qrCard(opts.csrfToken, status ? `<div aria-live="polite">${status}</div>` : ""),
  );
}

export function connectHomePage(opts: { csrfToken: string; statusHtml?: string }): string {
  return connectLoginPage(opts);
}

export function connectOtpPage(opts: {
  csrfToken: string;
  pending: PendingAuthState;
  statusHtml?: string;
}): string {
  const csrf = esc(opts.csrfToken);
  const status = opts.statusHtml ?? "";
  return connectLayout(
    "Kode OTP Shopee",
    opts.csrfToken,
    `<section class="card" aria-labelledby="otp-title">
  ${brandRow("Verifikasi")}
  <header class="card-header">
    <h1 id="otp-title">Masukkan kode OTP</h1>
    <p class="subtitle">Shopee mengirim kode ke akun yang masuk. OTP tidak disimpan.</p>
  </header>
  ${status ? `<div aria-live="polite">${status}</div>` : ""}
  <form method="POST" action="/connect/otp" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <label for="vcode">Kode OTP</label>
    <input class="field" id="vcode" name="vcode" required minlength="4" maxlength="8" autocomplete="one-time-code" placeholder="123456"/>
    <div class="actions">
      <button type="submit" class="btn btn-primary">Verifikasi</button>
    </div>
  </form>
  <form method="POST" action="/connect/otp/resend" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-secondary">Kirim ulang OTP</button>
  </form>
  <form method="POST" action="/connect/cancel">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-danger">Batal</button>
  </form>
</section>`,
  );
}

export function connectPasteNeededHtml(opts: { csrfToken: string; reason: string }): string {
  return connectLoginPage({
    csrfToken: opts.csrfToken,
    statusHtml: `<div class="panel panel-warning err" role="alert">
  <span class="status-icon" aria-hidden="true">!</span>
  <div><strong>Scan QR lewat <code>bun run auth</code></strong><br/><span>${esc(opts.reason)}</span></div>
</div>`,
  });
}

export function connectSuccessHtml(opts: {
  csrfToken: string;
  via: string;
  cookieCount: number;
  userPrefix?: string;
}): string {
  const csrf = esc(opts.csrfToken);
  const disconnect = opts.csrfToken
    ? `<form method="POST" action="/connect/disconnect">
      <input type="hidden" name="csrf" value="${csrf}"/>
      <button type="submit" class="btn btn-danger">Putuskan</button>
    </form>`
    : "";
  const userRow = opts.userPrefix
    ? `<div class="meta-row"><dt>Prefix user</dt><dd>${esc(opts.userPrefix)}</dd></div>`
    : "";
  return connectLayout(
    "Akun terhubung",
    opts.csrfToken,
    `<section class="card" aria-labelledby="success-title">
  ${brandRow("Sesi tersimpan")}
  <header class="card-header">
    <h1 id="success-title">Akun Shopee terhubung</h1>
    <p class="subtitle">MCP dapat membaca data akun buyer ini (profil, pesanan, keranjang, voucher).</p>
  </header>
  <div class="panel panel-success">
    <span class="status-icon" aria-hidden="true">✓</span>
    <div><strong>Connect berhasil</strong><br/><span class="muted">Nilai cookie tidak ditampilkan.</span></div>
  </div>
  <dl class="meta-list">
    <div class="meta-row"><dt>Sumber</dt><dd>${esc(opts.via)}</dd></div>
    <div class="meta-row"><dt>Jumlah cookie</dt><dd>${esc(String(opts.cookieCount))}</dd></div>
    ${userRow}
  </dl>
  <div class="actions">
    <a class="btn btn-primary" href="/connect">Selesai</a>
    ${disconnect}
  </div>
</section>`,
  );
}

export function connectErrorHtml(opts: { csrfToken: string; message: string }): string {
  return connectLoginPage({
    csrfToken: opts.csrfToken,
    statusHtml: `<div class="panel panel-danger err" role="alert">
  <span class="status-icon" aria-hidden="true">!</span>
  <div><strong>Gagal</strong><br/><span>${esc(opts.message)}</span></div>
</div>`,
  });
}

export function connectGoneHtml(opts: { csrfToken: string; message: string }): string {
  return connectLayout(
    "Hop tidak didukung",
    opts.csrfToken,
    `<section class="card" aria-labelledby="gone-title">
  ${brandRow("Hop ditolak")}
  <header class="card-header">
    <h1 id="gone-title">SSO dan Open Platform tidak didukung</h1>
    <p class="subtitle">${esc(opts.message)}</p>
  </header>
  <div class="panel panel-danger">
    <span class="status-icon" aria-hidden="true">!</span>
    <div><strong>410 Gone</strong><br/><span class="muted">Jalankan <code>bun run auth</code> lalu scan QR di aplikasi Shopee.</span></div>
  </div>
  <div class="actions">
    <a class="btn btn-primary" href="/connect">Buka Connect</a>
  </div>
</section>`,
  );
}

export function connectDisconnectedHtml(csrfToken: string): string {
  return connectLoginPage({
    csrfToken,
    statusHtml: '<div class="ok">Terputus. Cookie sesi dihapus.</div>',
  });
}
