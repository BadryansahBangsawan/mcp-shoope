import { brandRow, esc, layout } from "../web/html";
import { SCOPES } from "./scopes";

const SCOPE_LABELS: Record<string, string> = {
  [SCOPES.READ]: "Baca data akun buyer yang terhubung (profil, pesanan, keranjang, voucher)",
  [SCOPES.WRITE]: "Minta perubahan yang tetap butuh persetujuan owner per operasi",
  [SCOPES.ADMIN]: "Akses administratif, termasuk baca dan tulis",
};

export function ownerLoginPage(opts: { csrf: string; next: string; error?: string }): string {
  const err = opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : "";
  return layout(
    "Log in",
    `<section class="card card-login" aria-labelledby="login-title">
  ${brandRow()}
  <h1 id="login-title">Log in</h1>
  ${err}
  <form method="POST" action="/login" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${esc(opts.csrf)}"/>
    <input type="hidden" name="next" value="${esc(opts.next)}"/>
    <label class="sr-only" for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Password"${opts.error ? ' aria-invalid="true" aria-describedby="login-error"' : ""}/>
    ${opts.error ? '<span class="sr-only" id="login-error">Password tidak diterima.</span>' : ""}
    <button type="submit" class="btn btn-primary btn-block">Log in</button>
  </form>
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
  const err = o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : "";
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
    ? `<label class="sr-only" for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="Password"${o.error ? ' aria-invalid="true"' : ""}/>`
    : "";
  let redirectOrigin = o.redirectUri;
  try {
    redirectOrigin = new URL(o.redirectUri).origin;
  } catch {
    // Display the raw value when an origin cannot be derived.
  }
  return layout(
    "Otorisasi",
    `<section class="card" aria-labelledby="authorization-title">
  ${brandRow()}
  <h1 id="authorization-title">Otorisasi</h1>
  <p class="subtitle">${esc(o.clientName)} → ${esc(redirectOrigin)}</p>
  ${err}
  <form method="POST" action="${esc(o.actionUrl)}" autocomplete="off" class="form-stack">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}"/>
    <fieldset style="min-width:0;margin:0;padding:0;border:0">
      <legend class="sr-only">Izin</legend>
      ${scopes}
    </fieldset>
    ${password}
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="btn btn-primary">Setujui</button>
      <button type="submit" name="decision" value="deny" class="btn btn-danger" formnovalidate>Tolak</button>
    </div>
  </form>
</section>`,
  );
}

export function simpleErrorPage(title: string, message: string): string {
  return layout(
    title,
    `<section class="card card-login" aria-labelledby="error-title">
  ${brandRow()}
  <h1 id="error-title">${esc(title)}</h1>
  <p class="err" role="alert">${esc(message)}</p>
</section>`,
  );
}
