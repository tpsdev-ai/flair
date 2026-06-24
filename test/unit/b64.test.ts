import { describe, expect, test } from "bun:test";
import { b64ToArrayBuffer } from "../../resources/b64.js";

// Helpers: encode bytes as standard base64 vs (unpadded) base64url.
function toStdBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function toBase64url(bytes: Uint8Array): string {
  return toStdBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Mirror of importEd25519Key's decode-and-import (resources/*-auth.ts) so the test
// exercises the same path the auth gate takes for a base64url-registered pubkey.
async function importEd25519Key(publicKeyStr: string): Promise<CryptoKey> {
  let raw: ArrayBuffer;
  if (/^[0-9a-f]{64}$/i.test(publicKeyStr)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(publicKeyStr.slice(i * 2, i * 2 + 2), 16);
    raw = bytes.buffer;
  } else {
    raw = b64ToArrayBuffer(publicKeyStr);
  }
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" } as any, false, ["verify"]);
}

// Find a keypair whose public key, in base64url form, contains BOTH `-` and `_`
// (the chars that the old raw-atob decoder rejected).
async function genKeyWithUrlSafeChars(): Promise<{
  keyPair: CryptoKeyPair;
  rawPub: Uint8Array;
  pubUrl: string;
  pubStd: string;
}> {
  for (let i = 0; i < 2000; i++) {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" } as any,
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const pubUrl = toBase64url(rawPub);
    if (pubUrl.includes("-") && pubUrl.includes("_")) {
      return { keyPair, rawPub, pubUrl, pubStd: toStdBase64(rawPub) };
    }
  }
  throw new Error("could not generate a key with both - and _ in base64url form");
}

describe("b64ToArrayBuffer", () => {
  test("standard base64 (with + / =) still decodes unchanged", () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128, 62, 63]); // 62→'+' 63→'/'
    const std = toStdBase64(original);
    expect(std).toMatch(/[+/]/); // sanity: contains a + or /
    const out = new Uint8Array(b64ToArrayBuffer(std));
    expect(bytesEqual(out, original)).toBe(true);
  });

  test("base64url with BOTH - and _ decodes to identical bytes as standard form", () => {
    // 0xFB → '+' / '-', 0xFF... chosen so the encoding yields both - and _.
    const original = new Uint8Array([0xfb, 0xff, 0xbf, 0xfe, 0x3e, 0x3f]);
    const std = toStdBase64(original);
    const url = toBase64url(original);
    expect(url).toContain("-");
    expect(url).toContain("_");
    expect(std).not.toBe(url); // different alphabets

    const fromStd = new Uint8Array(b64ToArrayBuffer(std));
    const fromUrl = new Uint8Array(b64ToArrayBuffer(url));
    expect(bytesEqual(fromUrl, fromStd)).toBe(true);
    expect(bytesEqual(fromUrl, original)).toBe(true);
  });

  test("unpadded base64url (no trailing =) decodes correctly", () => {
    const original = new Uint8Array([10, 20, 30, 40, 50]); // 5 bytes → mod-4 padding needed
    const url = toBase64url(original);
    expect(url).not.toContain("="); // unpadded
    const out = new Uint8Array(b64ToArrayBuffer(url));
    expect(bytesEqual(out, original)).toBe(true);
  });

  test("a 32-byte key in base64url and standard form decode identically", async () => {
    const { rawPub, pubUrl, pubStd } = await genKeyWithUrlSafeChars();
    const fromUrl = new Uint8Array(b64ToArrayBuffer(pubUrl));
    const fromStd = new Uint8Array(b64ToArrayBuffer(pubStd));
    expect(bytesEqual(fromUrl, fromStd)).toBe(true);
    expect(bytesEqual(fromUrl, rawPub)).toBe(true);
    expect(fromUrl.length).toBe(32);
  });
});

describe("Ed25519 sign→verify with a base64url-registered pubkey", () => {
  test("full round-trip succeeds for a base64url pubkey containing - and _", async () => {
    const { keyPair, pubUrl } = await genKeyWithUrlSafeChars();

    // Agent's stored publicKey is the base64url form (the cross-org dogfood case).
    const importedPub = await importEd25519Key(pubUrl);

    // Sign a representative auth payload, then verify with the imported key.
    const payload = new TextEncoder().encode(
      "flint:1709000000000:nonce123:GET:/Memory",
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" } as any, keyPair.privateKey, payload),
    );

    // Signature also travels as base64url over the wire — decode it the same way.
    const sigUrl = toBase64url(sig);
    const sigBuf = b64ToArrayBuffer(sigUrl);

    const ok = await crypto.subtle.verify(
      { name: "Ed25519" } as any,
      importedPub,
      sigBuf,
      payload,
    );
    expect(ok).toBe(true);
  });
});
