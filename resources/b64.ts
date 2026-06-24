/**
 * b64 — single shared base64 / base64url decoder for Ed25519 auth.
 *
 * This was previously copy-pasted into three files (auth-middleware.ts,
 * agent-auth.ts, Presence.ts) and they drifted: some copies fed url-safe input
 * straight to `atob`, which rejects `-`/`_` ("Invalid character") and 401s any
 * agent whose public key (or signature) is base64url-encoded. Found in the
 * Rivet × krais cross-org dogfood: an Agent registered with a base64url pubkey
 * containing `-`/`_` failed signature verification. One shared decoder so the
 * three call sites can't diverge again (same lesson as HarperFast/harper#1466).
 *
 * Accepts BOTH standard base64 (`+` `/`, with optional `=` padding) AND
 * base64url (`-` `_`, padded or unpadded). Standard input is unchanged.
 */

/**
 * Decode a base64 OR base64url string to an ArrayBuffer.
 *
 * Normalizes url-safe alphabet (`-`→`+`, `_`→`/`) and right-pads with `=` to a
 * length that is a multiple of 4 before calling `atob`, so unpadded base64url
 * (the common JWK / Buffer.toString('base64url') form — e.g. a 32-byte key is
 * 43 chars, a 64-byte signature is 86 chars) decodes correctly regardless of
 * how lenient the host runtime's `atob` is about missing padding.
 */
export function b64ToArrayBuffer(b64: string): ArrayBuffer {
  // Normalize base64url → standard base64 alphabet.
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  // Right-pad to a multiple of 4 so atob accepts unpadded base64url input.
  const remainder = std.length % 4;
  if (remainder === 2) std += "==";
  else if (remainder === 3) std += "=";
  // remainder === 1 is not a valid base64 length; let atob throw as before.
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}
