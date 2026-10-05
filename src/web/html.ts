/** Shared HTML helpers for browser-facing pages (/authorize, /login, /connect). */

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function brandRow(status = "Secure connection"): string {
  return `<div class="brand-row">
  <span class="brand-mark" aria-hidden="true">S</span>
  <span class="brand">Shopee</span>
  <span class="secure-icon" aria-hidden="true"></span>
  <span class="secure-label">${esc(status)}</span>
</div>`;
}

export function layout(title: string, body: string, suffix = "shopee-mcp"): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="referrer" content="no-referrer"/>
  <title>${esc(title)} · ${esc(suffix)}</title>
  <style>
    :root {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #14201d;
      background: #f5f6f4;
      color-scheme: light;
      font-synthesis: none;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: #f5f6f4; }
    body {
      min-width: 0;
      min-height: 100vh;
      min-height: 100dvh;
      margin: 0;
      background: #f5f6f4;
      color: #14201d;
      -webkit-font-smoothing: antialiased;
    }
    button, input, textarea { font: inherit; }
    button, input, textarea, pre, code { max-width: 100%; }
    button, input, textarea { border-radius: 8px; }
    button { appearance: none; }
    .page-shell {
      width: 100%;
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: clamp(16px, 5vw, 44px);
    }
    .card {
      width: min(100%, 540px);
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 24px 28px;
      overflow: hidden;
      background: #fff;
      border: 1px solid #dde3df;
      border-radius: 14px;
    }
    .card.card-compact, .connect-card { width: min(100%, 520px); }
    .brand-row {
      min-width: 0;
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      display: inline-grid;
      place-items: center;
      border-radius: 8px;
      background: #ee4d2d;
      color: #fff;
      font-size: 18px;
      font-weight: 750;
      line-height: 1;
    }
    .brand {
      color: #18302a;
      font-size: 17px;
      font-weight: 750;
      letter-spacing: -.01em;
    }
    .secure-icon {
      position: relative;
      width: 14px;
      height: 16px;
      margin-left: 1px;
      flex: 0 0 14px;
      border: 1.5px solid currentColor;
      border-radius: 7px 7px 8px 8px;
      color: #ee4d2d;
    }
    .secure-icon::after {
      content: "";
      position: absolute;
      left: 3px;
      top: 3px;
      width: 5px;
      height: 3px;
      border-left: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg);
    }
    .secure-label {
      min-width: 0;
      color: #ee4d2d;
      font-size: 11px;
      font-weight: 650;
      line-height: 1.25;
    }
    .card-header { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    h1 {
      margin: 0;
      color: #14201d;
      font-size: 28px;
      font-weight: 750;
      line-height: 1.15;
      letter-spacing: -.025em;
    }
    .subtitle {
      margin: 0;
      color: #62706c;
      font-size: 15px;
      line-height: 1.45;
    }
    p { margin: 0; line-height: 1.5; }
    .panel, .warn, .ok, .err {
      min-width: 0;
      padding: 13px 14px;
      border: 1px solid;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .panel { display: flex; flex-direction: column; gap: 8px; }
    .panel-neutral { color: #3b4542; background: #f7f6f2; border-color: #e8dccb; }
    .panel-success, .ok { color: #185c4c; background: #f1f6f4; border-color: #cde4dc; }
    .panel-warning, .warn { color: #765b2a; background: #fff7e8; border-color: #ead7af; }
    .panel-danger, .err { color: #8f2018; background: #fef2f2; border-color: #f0c5c0; }
    .panel-title { color: #28241f; font-size: 14px; font-weight: 750; }
    .panel-heading {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 10px;
    }
    .client-mark {
      width: 30px;
      height: 30px;
      flex: 0 0 30px;
      display: inline-grid;
      place-items: center;
      border: 1px solid #ebc9a8;
      border-radius: 7px;
      background: #efede8;
      color: #9a5a27;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      font-weight: 700;
    }
    .panel-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .eyebrow { color: #7a7167; font-size: 11px; }
    .detail-row, .meta-row {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .detail-label, .meta-label {
      flex: 0 0 auto;
      color: #756b60;
      font-size: 11px;
      font-weight: 650;
    }
    .detail-value, .meta-value {
      min-width: 0;
      color: #66736f;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 10px;
      overflow-wrap: anywhere;
    }
    .meta-list { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    .section-label {
      margin: 0;
      color: #7b8985;
      font-size: 10px;
      font-weight: 750;
      letter-spacing: .09em;
      line-height: 1.3;
      text-transform: uppercase;
    }
    form { min-width: 0; }
    .form-stack { display: flex; flex-direction: column; gap: 14px; }
    .form-stack fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    dl.meta-list .meta-row { justify-content: space-between; }
    dl.meta-list dt, dl.meta-list dd { margin: 0; }
    .field { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    .field-label-row {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    label {
      display: block;
      color: #26332f;
      font-size: 12px;
      font-weight: 650;
      line-height: 1.35;
    }
    .field-hint { color: #87928e; font-size: 10px; font-weight: 400; text-align: right; }
    input:not([type="checkbox"]):not([type="radio"]), textarea {
      width: 100%;
      min-width: 0;
      min-height: 42px;
      padding: 9px 12px;
      border: 1px solid #bac9c4;
      background: #fff;
      color: #14201d;
      outline: 0;
    }
    input::placeholder, textarea::placeholder { color: #87928e; opacity: 1; }
    textarea {
      min-height: 92px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    input:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible {
      outline: 3px solid rgba(238, 77, 45, .26);
      outline-offset: 2px;
    }
    input:not([type="checkbox"]):not([type="radio"]):focus-visible, textarea:focus-visible {
      border-color: #ee4d2d;
    }
    input[aria-invalid="true"] { border-color: #dc2626; background: #fff7f7; }
    .radio-card, label.check {
      width: 100%;
      min-width: 0;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin: 0;
      padding: 10px 11px;
      border: 1px solid #cde4dc;
      border-radius: 8px;
      background: #f1f6f4;
      color: #183b34;
      cursor: pointer;
    }
    .radio-card + .radio-card, label.check + label.check { margin-top: 8px; }
    .radio-card:has(input:disabled), label.check:has(input:disabled) {
      cursor: not-allowed;
      opacity: .65;
    }
    .radio-card input, label.check input {
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
      margin: 1px 0 0;
      accent-color: #ee4d2d;
    }
    .radio-card-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .scope-name {
      color: #183b34;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .scope-description { color: #647570; font-size: 11px; font-weight: 400; line-height: 1.35; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    button, .btn {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      margin: 0;
      padding: 8px 14px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: #ee4d2d;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    button:hover, .btn:hover { background: #d73211; }
    button:active, .btn:active { transform: translateY(1px); }
    button:disabled, .btn:disabled { cursor: not-allowed; opacity: .55; }
    button.secondary, .btn-secondary {
      border-color: #c7d1ce;
      background: #fff;
      color: #33413d;
    }
    button.secondary:hover, .btn-secondary:hover { background: #f4f6f5; }
    .btn-danger {
      border-color: #e9cfcc;
      background: #fef2f2;
      color: #b42318;
    }
    .btn-danger:hover { background: #fde7e7; }
    button.choice {
      width: 100%;
      justify-content: flex-start;
      margin-top: 8px;
      border-color: #cde4dc;
      background: #f1f6f4;
      color: #183b34;
      text-align: left;
      white-space: normal;
    }
    .muted { color: #62706c; font-size: 12px; line-height: 1.45; }
    .inline-note {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #54635f;
      font-size: 12px;
    }
    .panel.inline-note { flex-direction: row; }
    .inline-note:not(.panel)::before {
      content: "";
      width: 8px;
      height: 4px;
      flex: 0 0 8px;
      border-left: 2px solid #ee4d2d;
      border-bottom: 2px solid #ee4d2d;
      transform: rotate(-45deg);
    }
    .privacy-note {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 7px;
      margin: 0;
      color: #7d8985;
      font-size: 10px;
      line-height: 1.4;
      text-align: center;
    }
    .privacy-note::before {
      content: "";
      width: 9px;
      height: 7px;
      flex: 0 0 9px;
      margin-top: 3px;
      border: 1px solid currentColor;
      border-radius: 2px;
    }
    .status-icon {
      width: 26px;
      height: 26px;
      flex: 0 0 26px;
      display: inline-grid;
      place-items: center;
      border: 1px solid currentColor;
      border-radius: 50%;
      font-size: 14px;
      font-weight: 750;
      line-height: 1;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      padding: 3px 7px;
      border-radius: 999px;
      background: #e4f1ed;
      color: #185c4c;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
    }
    .badge-warning { background: #fff0cd; color: #765b2a; }
    .badge-danger { background: #fde1de; color: #8f2018; }
    .badge-neutral { background: #e9ecea; color: #4f5d59; }
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: .92em;
      overflow-wrap: anywhere;
    }
    .code-block {
      width: 100%;
      max-height: 250px;
      margin: 0;
      padding: 12px;
      overflow: auto;
      border: 1px solid #dce3e0;
      border-radius: 8px;
      background: #f7f8f7;
      color: #33413d;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    a { color: #ee4d2d; text-underline-offset: 2px; }
    .row { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 420px) {
      .page-shell { justify-content: flex-start; padding: 12px; }
      .card { padding: 20px 18px; border-radius: 12px; }
      h1 { font-size: 24px; }
      .subtitle { font-size: 14px; }
      .detail-row, .meta-row { flex-direction: column; gap: 3px; }
      .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr); }
      .actions > .btn, .actions > button { width: 100%; min-width: 0; padding-inline: 9px; }
      button, .btn { min-height: 44px; }
      .field-label-row { align-items: flex-start; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
        transition-delay: 0ms !important;
      }
      button:active, .btn:active { transform: none; }
    }
  </style>
</head>
<body>
<main class="page-shell">
${body}
</main>
</body>
</html>`;
}

/**
 * HTML response with anti-framing, no-store and a strict CSP.
 * `form-action` is intentionally omitted: browsers apply it to the post-submit
 * redirect, which would block the OAuth redirect back to the client.
 */
export function htmlResponse(html: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(html, { status, headers });
}
