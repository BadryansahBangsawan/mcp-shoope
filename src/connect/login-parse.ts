/**
 * Buyer login helpers. Username/OTP rules are local; response heuristics are
 * fail-closed (captcha/anti-bot → paste, OTP → pending, else error).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_RE = /^[A-Za-z0-9]{4,8}$/;
const OTP_HINT = /otp|vcode|ivs|verify|sms|whatsapp/i;
const CAPTCHA_HINT = /captcha|anti.?bot|af-ac|recaptcha|slider|unusual traffic/i;

export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[\s()-]/g, "");
  if (digits.startsWith("+62")) return `62${digits.slice(3).replace(/\D/g, "")}`;
  if (digits.startsWith("62") && /^\d+$/.test(digits)) return digits;
  if (digits.startsWith("08") && /^\d+$/.test(digits)) return `62${digits.slice(1)}`;
  return trimmed;
}

export function isValidOtp(raw: string): boolean {
  return OTP_RE.test(raw.trim());
}

export function isValidEmailUsername(username: string): boolean {
  return EMAIL_RE.test(username);
}

export interface LoginEnvelope {
  /** Empty/0/null means "no error code". */
  error: string | number | null;
  message: string;
  raw: unknown;
}

export function parseLoginJson(json: unknown): LoginEnvelope {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { error: "non_object", message: "Non-object login response", raw: json };
  }
  const o = json as Record<string, unknown>;
  const error = firstPresent(o.error, o.error_code, o.errcode, o.err_code);
  const message = [o.error_msg, o.error_message, o.message, o.msg]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ");
  return { error, message, raw: json };
}

export function isSuccessError(error: string | number | null): boolean {
  return error === null || error === undefined || error === "" || error === 0 || error === "0";
}

export function isOtpHint(error: string | number | null, message: string): boolean {
  const hay = `${error ?? ""} ${message}`;
  return OTP_HINT.test(hay);
}

export function isCaptchaHint(status: number, error: string | number | null, message: string, body = ""): boolean {
  if (status === 403 && looksLikeHtml(body) && CAPTCHA_HINT.test(body.slice(0, 8000))) return true;
  const hay = `${error ?? ""} ${message} ${body.slice(0, 4000)}`;
  return CAPTCHA_HINT.test(hay);
}

export function looksLikeHtml(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") || /<html[\s>]/i.test(t.slice(0, 400));
}

export function extractCsrfFromHtml(html: string): string | null {
  const m =
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i) ||
    html.match(/["']csrftoken["']\s*[:=]\s*["']([^"']{8,})["']/i);
  const v = m?.[1]?.trim();
  return v && isPrintableToken(v) ? v : null;
}

export function isPrintableToken(value: string): boolean {
  return /^[\x21-\x7e]{8,2048}$/.test(value);
}

function firstPresent(...values: unknown[]): string | number | null {
  for (const v of values) {
    if (v === undefined) continue;
    if (v === null || v === "") return v as string | null;
    if (typeof v === "number" || typeof v === "string") return v;
  }
  return null;
}
