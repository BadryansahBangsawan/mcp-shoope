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

function pasteCard(csrfToken: string, extra = ""): string {
  const csrf = esc(csrfToken);
  return `<section class="card" id="paste" aria-labelledby="paste-title">
  <header class="card-header">
    <h2 id="paste-title">Tempel cookie (cadangan)</h2>
    <p class="subtitle">JSON <code>v:1</code>, <code>source:"browser-export"</code>, daftar cookie <code>shopee.co.id</code>. Dipakai jika login Worker kena captcha/anti-bot. Jangan bagikan nilainya.</p>
  </header>
  ${extra}
  <form method="POST" action="/connect/paste" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <label for="tokens">Bundle cookie JSON</label>
    <textarea class="field" id="tokens" name="tokens" required minlength="20" placeholder='{"v":1,"source":"browser-export","cookies":[{"name":"SPC_EC","value":"…","domain":".shopee.co.id","path":"/"}]}'></textarea>
    <div class="actions">
      <button type="submit" class="btn btn-secondary">Simpan cookie</button>
    </div>
  </form>
  <form method="POST" action="/connect/disconnect">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-danger">Putuskan sesi akun</button>
  </form>
</section>`;
}

export function connectLoginPage(opts: { csrfToken: string; statusHtml?: string }): string {
  const csrf = esc(opts.csrfToken);
  const status = opts.statusHtml ?? "";
  return connectLayout(
    "Connect Shopee",
    opts.csrfToken,
    `<section class="card" aria-labelledby="login-title">
  ${brandRow("Masuk akun buyer")}
  <header class="card-header">
    <h1 id="login-title">Hubungkan akun Shopee</h1>
    <p class="subtitle">Satu akun buyer di <strong>shopee.co.id</strong>. Password hanya untuk request ini — tidak disimpan.</p>
  </header>
  <div class="panel panel-neutral inline-note">
    <span class="status-icon" aria-hidden="true">i</span>
    <span>Worker meniru form login resmi. Jika Shopee menampilkan captcha, tempel cookie dari browser rumah.</span>
  </div>
  ${status ? `<div aria-live="polite">${status}</div>` : ""}
  <form method="POST" action="/connect/login" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <label for="username">HP atau email</label>
    <input class="field" id="username" name="username" required autocomplete="username" placeholder="0812… atau nama@contoh.com"/>
    <label for="password">Password</label>
    <input class="field" id="password" name="password" type="password" required autocomplete="current-password"/>
    <div class="actions">
      <button type="submit" class="btn btn-primary">Masuk</button>
    </div>
  </form>
</section>
${pasteCard(opts.csrfToken)}`,
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
  <div><strong>Login Worker tidak bisa dilanjutkan</strong><br/><span>${esc(opts.reason)}</span></div>
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
    <div><strong>410 Gone</strong><br/><span class="muted">Masuk dengan HP/email di /connect.</span></div>
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
