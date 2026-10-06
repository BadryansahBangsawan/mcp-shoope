import { brandRow, esc, layout } from "../web/html";
import { SCOPES } from "./scopes";

const SCOPE_LABELS: Record<string, string> = {
  [SCOPES.READ]: "Baca data akun buyer yang terhubung (profil, pesanan, keranjang, voucher)",
  [SCOPES.WRITE]: "Minta perubahan yang tetap butuh persetujuan owner per operasi",
  [SCOPES.ADMIN]: "Akses administratif, termasuk baca dan tulis",
};

export function ownerLoginPage(opts: { csrf: string; next: string; error?: string }): string {
  const err = opts.error
    ? `<div class="panel panel-danger" role="alert"><div class="panel-heading"><span class="status-icon" aria-hidden="true">!</span><div><strong>Masuk gagal</strong><br/>${esc(opts.error)}</div></div></div>`
    : "";
  return layout(
    "Masuk owner",
    `<section class="card card-compact" aria-labelledby="login-title">
  ${brandRow("Akses owner aman")}
  <header class="card-header">
    <h1 id="login-title">Masuk owner</h1>
    <p class="subtitle">Masukkan password owner untuk lanjut ke server Shopee MCP ini.</p>
  </header>
  <div class="panel panel-neutral">
    <strong>Akses server privat</strong>
    <span>Hanya owner yang dapat mengotorisasi klien dan menghubungkan akun buyer Shopee.</span>
  </div>
  ${err}
  <form method="POST" action="/login" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${esc(opts.csrf)}"/>
    <input type="hidden" name="next" value="${esc(opts.next)}"/>
    <div class="field">
      <div class="field-label-row">
        <label for="password">Password owner</label>
        <span class="field-hint">Wajib</span>
      </div>
      <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Masukkan password owner"${opts.error ? ' aria-invalid="true" aria-describedby="login-error"' : ""}/>
      ${opts.error ? '<span class="sr-only" id="login-error">Password owner tidak diterima.</span>' : ""}
    </div>
    <div class="actions">
      <button type="submit" class="btn btn-primary">Masuk dengan aman</button>
    </div>
  </form>
  <p class="privacy-note">Password hanya dipakai untuk memverifikasi akses owner. Bukan password akun Shopee.</p>
</section>`,
  );
}

export interface ConsentPageOptions {
  csrf: string;
  actionUrl: string;
  clientName: string;
  clientId: string;
  redirectUri: string;
  offeredScopes: string[];
  defaultScopes: string[];
  needsPassword: boolean;
  error?: string;
}

export function consentPage(o: ConsentPageOptions): string {
  const err = o.error
    ? `<div class="panel panel-danger" role="alert"><div class="panel-heading"><span class="status-icon" aria-hidden="true">!</span><div><strong>Otorisasi perlu perhatian</strong><br/>${esc(o.error)}</div></div></div>`
    : "";
  const scopes = o.offeredScopes
    .map((scope) => {
      const checked = o.defaultScopes.includes(scope) ? " checked" : "";
      return `<label class="radio-card">
      <input type="checkbox" name="scope" value="${esc(scope)}"${checked}/>
      <span class="radio-card-copy">
        <span class="scope-name">${esc(scope)}</span>
        <span class="scope-description">${esc(SCOPE_LABELS[scope] ?? scope)}</span>
      </span>
    </label>`;
    })
    .join("\n");
  const password = o.needsPassword
    ? `<div class="field">
      <div class="field-label-row">
        <label for="password">Password owner</label>
        <span class="field-hint">Wajib untuk menyetujui</span>
      </div>
      <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Masukkan password owner"${o.error ? ' aria-invalid="true" aria-describedby="authorization-error"' : ""}/>
      ${o.error ? '<span class="sr-only" id="authorization-error">Tinjau error otorisasi di atas.</span>' : ""}
    </div>`
    : `<p class="inline-note">Sudah masuk sebagai owner</p>`;
  let redirectOrigin = o.redirectUri;
  try {
    redirectOrigin = new URL(o.redirectUri).origin;
  } catch {
    // Display the raw value when an origin cannot be derived.
  }
  return layout(
    "Otorisasi klien MCP",
    `<section class="card" aria-labelledby="authorization-title">
  ${brandRow()}
  <header class="card-header">
    <h1 id="authorization-title">Otorisasi klien MCP</h1>
    <p class="subtitle">${esc(o.clientName)} meminta akses ke akun buyer Shopee yang terhubung di server ini.</p>
  </header>
  <div class="panel panel-neutral">
    <div class="panel-heading">
      <span class="client-mark" aria-hidden="true">&gt;_</span>
      <span class="panel-copy">
        <strong class="panel-title">${esc(o.clientName)}</strong>
        <span class="eyebrow">Klien yang mengklaim identitas sendiri</span>
      </span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Redirect ke</span>
      <code class="detail-value">${esc(redirectOrigin)}</code>
    </div>
    <span class="eyebrow">Setujui hanya jika Anda memulai koneksi ini dan mengenali redirect-nya.</span>
  </div>
  <div class="meta-list">
    <div class="meta-row">
      <span class="meta-label">Client ID</span>
      <code class="meta-value">${esc(o.clientId)}</code>
    </div>
  </div>
  ${err}
  <form method="POST" action="${esc(o.actionUrl)}" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}"/>
    <fieldset style="min-width:0;margin:0;padding:0;border:0">
      <legend class="section-label" style="margin-bottom:8px">Izin yang diminta</legend>
      ${scopes}
    </fieldset>
    ${password}
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="btn btn-primary">Setujui akses</button>
      <button type="submit" name="decision" value="deny" class="btn btn-danger" formnovalidate>Tolak</button>
    </div>
  </form>
  <p class="privacy-note">Password hanya dipakai untuk memverifikasi otorisasi ini.</p>
</section>`,
  );
}

export function simpleErrorPage(title: string, message: string): string {
  return layout(
    title,
    `<section class="card card-compact" aria-labelledby="error-title">
  ${brandRow("Permintaan ditutup")}
  <header class="card-header">
    <h1 id="error-title">${esc(title)}</h1>
    <p class="subtitle">Permintaan ini tidak dapat diselesaikan.</p>
  </header>
  <div class="panel panel-danger" role="alert">
    <div class="panel-heading">
      <span class="status-icon" aria-hidden="true">!</span>
      <span>${esc(message)}</span>
    </div>
  </div>
  <p class="privacy-note">Tidak ada data akun Shopee yang dibagikan.</p>
</section>`,
  );
}
