import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FlairClient } from "@tpsdev-ai/flair-client";
import { runWakeCycle } from "../src/index.ts";

test.each([
  ["public Ed25519", generateKeyPairSync("ed25519").publicKey, "public, not a private signing key"],
  ["private EC", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey, "ec, not Ed25519"],
] as const)("the exported live cycle refuses a %s KeyObject before calling request", async (_label, privateKey, detail) => {
  const client = new FlairClient({ agentId: "cycle-key-test", privateKey });
  let requests = 0;
  client.request = async () => {
    requests += 1;
    throw new Error("unexpected request");
  };
  let refused: unknown;
  try {
    await runWakeCycle({ client, cursor: { apiBase: "https://api.cursor.com", apiKey: "k" } });
  } catch (error) {
    refused = error;
  }
  expect((refused as Error)?.name).toBe("Error");
  expect((refused as Error)?.message).toContain("live receipts need the agent's signing key");
  expect((refused as Error)?.message).toContain(detail);
  expect(client.signingRequired).toBe(false);
  expect(requests).toBe(0);
});
