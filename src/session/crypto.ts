import { AppError, ErrorCodes } from "../errors/codes";

const ALGO = "AES-GCM";
const IV_LEN = 12;
const HKDF_SALT = "shopee-mcp/shopee-session-store";
const HKDF_INFO = "sp-session-aes-gcm-v2";

const enc = new TextEncoder();

export interface Ciphertext {
  iv: string;
  ct: string;
}

export interface SessionKeys {
  /** HKDF-derived AES-GCM key for all writes (always used with AAD). */
  aead: CryptoKey;
}

function b64Encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Secret bytes behind SESSION_ENCRYPTION_KEY: a base64 32-byte key (preferred,
 * `openssl rand -base64 32`) is used as-is; anything else is treated as a
 * utf-8 passphrase.
 */
function secretBytes(trimmed: string): Uint8Array {
  try {
    const decoded = b64Decode(trimmed);
    if (decoded.byteLength === 32) return decoded;
  } catch {
    // not base64 — passphrase
  }
  return enc.encode(trimmed);
}

/**
 * Import SESSION_ENCRYPTION_KEY. The AES key is derived with HKDF (distinct
 * label from the owner-cookie HMAC key derived from the same secret).
 */
export async function importSessionKeys(raw: string): Promise<SessionKeys> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "SESSION_ENCRYPTION_KEY is empty");
  }
  const bytes = secretBytes(trimmed);
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  const aead = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) },
    base,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { aead };
}

export async function encryptJson(
  key: CryptoKey,
  value: unknown,
  aad: string,
): Promise<Ciphertext> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plain = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv, additionalData: enc.encode(aad) },
    key,
    plain,
  );
  return { iv: b64Encode(iv), ct: b64Encode(ct) };
}

/**
 * Decrypt a blob. `aad` must match the value used at encryption.
 * Throws AppError(SHOPEE_AUTH_EXPIRED) on any authentication failure.
 */
export async function decryptJson<T>(
  key: CryptoKey,
  blob: Ciphertext,
  aad: string,
): Promise<T> {
  if (typeof blob.iv !== "string" || typeof blob.ct !== "string" || !blob.iv || !blob.ct) {
    throw new AppError(ErrorCodes.INVALID_INPUT, "Invalid encrypted session blob");
  }
  try {
    const iv = b64Decode(blob.iv);
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv, additionalData: enc.encode(aad) },
      key,
      b64Decode(blob.ct),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new AppError(
      ErrorCodes.SHOPEE_AUTH_EXPIRED,
      "Failed to decrypt session (wrong SESSION_ENCRYPTION_KEY?)",
    );
  }
}

export interface SessionCryptoEnv {
  SESSION_ENCRYPTION_KEY?: string;
  REQUIRE_SESSION_ENCRYPTION?: string;
}

export async function resolveSessionCrypto(
  env: SessionCryptoEnv,
): Promise<{ keys: SessionKeys | null; require: boolean }> {
  const require = env.REQUIRE_SESSION_ENCRYPTION === "true";
  const raw = env.SESSION_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (require) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        "REQUIRE_SESSION_ENCRYPTION=true but SESSION_ENCRYPTION_KEY is missing — refusing plaintext session storage",
      );
    }
    return { keys: null, require };
  }
  return { keys: await importSessionKeys(raw), require };
}
