import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairClient, MissingSigningKeyError } from "../src/client.js";

test.each([
  ["public Ed25519", generateKeyPairSync("ed25519").publicKey, "public, not a private signing key"],
  ["private EC", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey, "ec, not Ed25519"],
] as const)("loadSigningKey refuses a %s KeyObject without requiring signing", async (_label, privateKey, detail) => {
  const client = new FlairClient({ agentId: "loader-test", privateKey });
  let refused: unknown;
  try {
    await client.loadSigningKey();
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(MissingSigningKeyError);
  expect((refused as Error).name).toBe("MissingSigningKeyError");
  expect((refused as Error).message).toContain(detail);
  expect(client.signingRequired).toBe(false);
});

test("loadSigningKey accepts a private Ed25519 KeyObject and requires signing", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const client = new FlairClient({ agentId: "loader-test", privateKey });
  expect(await client.loadSigningKey()).toBe(privateKey);
  expect(client.signingRequired).toBe(true);
});

test("loadSigningKey accepts an Ed25519 key file and requires signing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flair-signing-loader-"));
  try {
    const keyPath = join(dir, "agent.key");
    await writeFile(keyPath, Buffer.alloc(32, 7));
    const client = new FlairClient({ agentId: "loader-test", keyPath });
    const loaded = await client.loadSigningKey();
    expect(loaded.type).toBe("private");
    expect(loaded.asymmetricKeyType).toBe("ed25519");
    expect(client.signingRequired).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
