/**
 * flair#3136 item 1: the doctor/init signing probes and the registration gate
 * apply the shared agent-ID rule before resolving a key path, so an invalid id
 * is refused with the shared message and no request is sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentRegistered, resolveProbeSigningIdentity, verifySemanticSearch } from "../../src/cli.ts";
import { invalidAgentIdMessage } from "../../src/lib/agent-id-rule.ts";

const BAD_ID = "../escape";
const realFetch = globalThis.fetch;
let requests: string[] = [];
let keysDir: string;

function isolate(): void {
  keysDir = mkdtempSync(join(tmpdir(), "flair-key-path-probe-3136-"));
  requests = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    throw new Error("no request expected");
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
});

describe("flair#3136 — the doctor and init probes refuse an invalid agent id", () => {
  test("resolveProbeSigningIdentity refuses before it resolves a key path", async () => {
    isolate();
    await expect(resolveProbeSigningIdentity("http://127.0.0.1:1", BAD_ID, keysDir))
      .rejects.toThrow(invalidAgentIdMessage(BAD_ID));
    expect(requests).toEqual([]);
  });

  test("verifySemanticSearch (the init probe) refuses before it resolves a key path", async () => {
    isolate();
    await expect(verifySemanticSearch("http://127.0.0.1:1", BAD_ID, keysDir))
      .rejects.toThrow(invalidAgentIdMessage(BAD_ID));
    expect(requests).toEqual([]);
  });

  test("checkAgentRegistered refuses with a no-key verdict and sends nothing", async () => {
    isolate();
    const result = await checkAgentRegistered("http://127.0.0.1:1", BAD_ID, keysDir);
    expect(result.state).toBe("no-key");
    expect(result.detail).toBe(invalidAgentIdMessage(BAD_ID));
    expect(requests).toEqual([]);
  });
});
