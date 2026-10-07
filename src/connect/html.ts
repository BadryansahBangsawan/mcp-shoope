import type { PendingAuthState } from "../session/types";
import { brandRow, esc, layout } from "../web/html";

function footer(csrfToken: string): string {
  if (!csrfToken) return "";
  return `<footer class="actions" aria-label="Akun">
  <form method="POST" action="/logout">
    <input type="hidden" name="csrf" value="${esc(csrfToken)}"/>
    <button type="submit" class="btn btn-secondary">Keluar</button>
  </form>
</footer>`;
}

function connectLayout(title: string, csrfToken: string, body: string): string {
  return layout(title, `${body}\n${footer(csrfToken)}`, "Shopee");
}

function alertHtml(message: string, kind: "err" | "ok" = "err"): string {
  return `<p class="${kind}" role="alert">${message}</p>`;
}

function loginCard(csrfToken: string, extra = ""): string {
  const csrf = esc(csrfToken);
  return `<section class="card card-login" aria-labelledby="login-title">
  ${brandRow()}
  <h1 id="login-title">Log in</h1>
  ${extra}
  <form method="POST" action="/connect/login" autocomplete="on" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <label class="sr-only" for="username">No. Handphone/Email/Username</label>
    <input id="username" name="username" required autocomplete="username" placeholder="No. Handphone/Email/Username"/>
    <label class="sr-only" for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Password"/>
    <button type="submit" class="btn btn-primary btn-block">Log in</button>
  </form>
</section>`;
}

export function connectLoginPage(opts: { csrfToken: string; statusHtml?: string }): string {
  return connectLayout("Log in", opts.csrfToken, loginCard(opts.csrfToken, opts.statusHtml ?? ""));
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
  return connectLayout(
    "Kode OTP",
    opts.csrfToken,
    `<section class="card card-login" aria-labelledby="otp-title">
  ${brandRow()}
  <h1 id="otp-title">Kode OTP</h1>
  ${opts.statusHtml ?? ""}
  <form method="POST" action="/connect/otp" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <label class="sr-only" for="vcode">Kode OTP</label>
    <input class="field" id="vcode" name="vcode" required minlength="4" maxlength="8" autocomplete="one-time-code" placeholder="Kode OTP"/>
    <button type="submit" class="btn btn-primary btn-block">Verifikasi</button>
  </form>
  <form method="POST" action="/connect/otp/resend">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-secondary btn-block">Kirim ulang</button>
  </form>
  <form method="POST" action="/connect/cancel">
    <input type="hidden" name="csrf" value="${csrf}"/>
    <button type="submit" class="btn btn-danger btn-block">Batal</button>
  </form>
</section>`,
  );
}

export function connectPasteNeededHtml(opts: { csrfToken: string; reason: string }): string {
  return connectLoginPage({
    csrfToken: opts.csrfToken,
    statusHtml: alertHtml(esc(opts.reason)),
  });
}

export function connectSuccessHtml(opts: {
  csrfToken: string;
  via: string;
  cookieCount: number;
  userPrefix?: string;
}): string {
  const csrf = esc(opts.csrfToken);
  const disconnect = `<form method="POST" action="/connect/disconnect">
      <input type="hidden" name="csrf" value="${csrf}"/>
      <button type="submit" class="btn btn-danger btn-block">Putuskan</button>
    </form>`;
  return connectLayout(
    "Terhubung",
    opts.csrfToken,
    `<section class="card card-login" aria-labelledby="success-title">
  ${brandRow()}
  <h1 id="success-title">Terhubung</h1>
  ${disconnect}
</section>`,
  );
}

export function connectErrorHtml(opts: { csrfToken: string; message: string }): string {
  return connectLoginPage({
    csrfToken: opts.csrfToken,
    statusHtml: alertHtml(esc(opts.message)),
  });
}

export function connectGoneHtml(opts: { csrfToken: string; message: string }): string {
  return connectLayout(
    "Tidak didukung",
    opts.csrfToken,
    `<section class="card card-login" aria-labelledby="gone-title">
  ${brandRow()}
  <h1 id="gone-title">Tidak didukung</h1>
  ${alertHtml(esc(opts.message))}
  <a class="btn btn-primary btn-block" href="/connect">Log in</a>
</section>`,
  );
}

export function connectDisconnectedHtml(csrfToken: string): string {
  return connectLoginPage({
    csrfToken,
    statusHtml: alertHtml("Terputus.", "ok"),
  });
}
