import { describe, expect, it } from "vitest";
import {
  decryptJson,
  encryptJson,
  importSessionKeys,
  resolveSessionCrypto,
  sha256Hex,
} from "../../src/session/crypto";
import { ErrorCodes } from "../../src/errors/codes";

const RAW_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const AAD = "sp-shopee-sessions|owner|session|session|exp=";

describe("session AES-GCM crypto", () => {
  it("round-trips JSON with a base64 32-byte key and AAD", async () => {
    const { aead } = await importSessionKeys(RAW_KEY);
    const blob = await encryptJson(
      aead,
      { access_token: "tok", shop_id: "1" },
      AAD,
    );
    expect(blob.iv).toBeTruthy();
    expect(blob.ct).toBeTruthy();
    const out = await decryptJson<{ access_token: string; shop_id: string }>(aead, blob, AAD);
    expect(out).toEqual({ access_token: "tok", shop_id: "1" });
  });

  it("binds ciphertext to its AAD", async () => {
    const { aead } = await importSessionKeys(RAW_KEY);
    const blob = await encryptJson(aead, { x: 1 }, AAD);
    await expect(
      decryptJson(aead, blob, "sp-shopee-sessions|other|session|session|exp="),
    ).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
  });

  it("fails on tampered ciphertext", async () => {
    const { aead } = await importSessionKeys(RAW_KEY);
    const blob = await encryptJson(aead, { x: 1 }, AAD);
    const raw = atob(blob.ct);
    const flipped = String.fromCharCode(raw.charCodeAt(0) ^ 0xff) + raw.slice(1);
    await expect(
      decryptJson(aead, { iv: blob.iv, ct: btoa(flipped) }, AAD),
    ).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
  });

  it("derives the AES key with HKDF (the raw key alone does not decrypt new blobs)", async () => {
    const { aead } = await importSessionKeys(RAW_KEY);
    const blob = await encryptJson(aead, { x: 1 }, AAD);
    const rawBytes = Uint8Array.from(atob(RAW_KEY), (c) => c.charCodeAt(0));
    const rawKey = await crypto.subtle.importKey("raw", rawBytes, "AES-GCM", false, ["decrypt"]);
    await expect(decryptJson(rawKey, blob, AAD)).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
  });

  it("does not expose a legacy v1 reader", async () => {
    const keys = await importSessionKeys(RAW_KEY);
    expect(keys).toEqual({ aead: expect.any(CryptoKey) });
    expect("legacy" in keys).toBe(false);
  });

  it("accepts a passphrase-style key", async () => {
    const { aead } = await importSessionKeys("dev-passphrase-not-for-prod");
    const blob = await encryptJson(aead, { x: 1 }, AAD);
    expect(await decryptJson<{ x: number }>(aead, blob, AAD)).toEqual({ x: 1 });
  });

  it("fails with a different key", async () => {
    const a = await importSessionKeys(RAW_KEY);
    const b = await importSessionKeys("another-passphrase-entirely");
    const blob = await encryptJson(a.aead, { x: 1 }, AAD);
    await expect(decryptJson(b.aead, blob, AAD)).rejects.toMatchObject({
      code: ErrorCodes.SHOPEE_AUTH_EXPIRED,
    });
  });

  it("fails closed when REQUIRE_SESSION_ENCRYPTION and no key", async () => {
    await expect(resolveSessionCrypto({ REQUIRE_SESSION_ENCRYPTION: "true" })).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
  });

  it("allows missing key when not required (plaintext unit tests)", async () => {
    const r = await resolveSessionCrypto({ REQUIRE_SESSION_ENCRYPTION: "false" });
    expect(r.keys).toBeNull();
    expect(r.require).toBe(false);
  });

  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
