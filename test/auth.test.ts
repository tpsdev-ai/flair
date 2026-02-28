import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

function signHeader(method: string, path: string, agentId: string, secretKeyB64: string, nonce: string, ts: number): string {
  const payload = `${method}:${path}:${ts}:${nonce}`;
  const sig = nacl.sign.detached(Buffer.from(payload), Buffer.from(secretKeyB64, "base64"));
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

describe("auth payload format", () => {
  test("builds expected TPS-Ed25519 payload with nonce", () => {
    const kp = nacl.sign.keyPair();
    const header = signHeader("GET", "/Agent", "flint", Buffer.from(kp.secretKey).toString("base64"), "abc", 1700000000000);
    expect(header.startsWith("TPS-Ed25519 flint:1700000000000:abc:")).toBe(true);
  });
});
