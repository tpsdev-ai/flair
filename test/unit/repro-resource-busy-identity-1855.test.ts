// scripts/repro-resource-busy.mjs signs as an identity the CALLER chose (flair#1855).
//
// It used to sign as a hardcoded 'flint' from one fixed legacy key path — a
// principal the caller never picked. It now requires FLAIR_AGENT_ID or
// --agent <id> and refuses without one, and shares the client's key resolution
// and signing (scripts/lib/flair-signing.mjs).
//
// The child runs with a dead FLAIR_URL and an empty temp home, so even a tree
// that ignored the identity could not reach a real instance or load a real key.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "repro-resource-busy.mjs");

const emptyHome = mkdtempSync(join(tmpdir(), "flair-1855-repro-"));
afterAll(() => rmSync(emptyHome, { recursive: true, force: true }));

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    FLAIR_KEY_DIR: emptyHome,
    // Port 9 (discard) — unreachable if anything ever tried to sign and send.
    FLAIR_URL: "http://127.0.0.1:9",
    ...extraEnv,
  };
  const proc = Bun.spawn(["node", SCRIPT, ...args], { env, stderr: "pipe", stdout: "pipe" });
  const code = await proc.exited;
  return { code, stderr: await new Response(proc.stderr).text() };
}

describe("repro-resource-busy requires a chosen identity (flair#1855)", () => {
  it("refuses without FLAIR_AGENT_ID or --agent", async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to run");
    expect(r.stderr).toContain("FLAIR_AGENT_ID");
    expect(r.stderr).toContain("--agent");
  });

  it("rejects --agent with no value", async () => {
    const r = await run(["--agent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--agent requires a value");
  });
});
