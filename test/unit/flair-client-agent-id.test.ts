// flair-client.mjs identity resolution for signing operations (flair#1816).
//
// The script used to resolve its agent id as `FLAIR_AGENT_ID || 'flint'`, so a
// mutating call that forgot the environment variable signed and wrote as
// 'flint' — a shipped default was the trust anchor, and ownership-scoped
// operations then bound to an identity the caller never chose. Mutations now
// refuse without an explicit identity (`FLAIR_AGENT_ID` or `--agent <id>`);
// #1851 extended that to every signed action, reads included.
//
// These tests spawn the real script as a subprocess with an explicitly
// constructed environment — no ambient FLAIR_*, and HOME/USERPROFILE/FLAIR_KEY_DIR
// pointed at an empty temp dir — so neither a developer's credentials nor the
// host's key files can decide a case's result. The refusal happens before the
// key load, which is also what makes "no record written" observable: the
// positive cases prove the guard was passed by reaching the key load, which
// names the resolved agent in its error. The end-to-end case then runs a real
// signing PUT against a recording server.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "flair-client.mjs");

// An empty directory standing in for the whole home: the key probe paths
// (~/.flair/keys, ~/.tps/secrets/flair) resolve inside it, so a developer's
// real keys cannot answer for the agent under test.
let emptyHome = "";

beforeAll(() => {
  emptyHome = mkdtempSync(join(tmpdir(), "flair-agent-id-"));
});

afterAll(() => {
  rmSync(emptyHome, { recursive: true, force: true });
});

// Async on purpose: the end-to-end case serves the child's request from this
// same process, and a synchronous spawn would block that server's event loop.
async function runClient(args: string[], extraEnv: Record<string, string> = {}) {
  // Deliberately NOT built from process.env: the lane's own unitEnvironment()
  // strips FLAIR_*/HARPER_*/HDB_*/FABRIC_*, and a child that inherited the
  // developer's deployment config could turn a missing mock into a real write.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    FLAIR_KEY_DIR: emptyHome,
  };
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  const proc = Bun.spawn(["node", SCRIPT, ...args], { env, stderr: "pipe", stdout: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stderr, stdout };
}

describe("flair-client agent identity (flair#1816)", () => {
  it("NEGATIVE: refuses a write with no identity, naming FLAIR_AGENT_ID", async () => {
    const r = await runClient(["memory", "write", "hello"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to write");
    expect(r.stderr).toContain("FLAIR_AGENT_ID");
    expect(r.stderr).toContain("--agent");
    // Refused before the key load: no key error means it never got that far,
    // so nothing could have been written under any identity.
    expect(r.stderr).not.toContain("no private key found");
  });

  it("NEGATIVE: refuses soul set and memory delete the same way", async () => {
    for (const args of [
      ["soul", "set", "voice", "dry"],
      ["memory", "delete", "flint-1"],
    ]) {
      const r = await runClient(args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refusing to");
      expect(r.stderr).not.toContain("no private key found");
    }
  });

  it("NEGATIVE: rejects --agent with no value", async () => {
    const r = await runClient(["memory", "write", "hello", "--agent"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--agent requires a value");
  });

  // The parser removes exactly one flag pair. A second `--agent` used to
  // survive the splice and land in the written content ("hello --agent flint"),
  // which is the flag-folding class extractFlags already refuses everywhere
  // else — a flag that stops being an instruction and becomes data.
  it("NEGATIVE: rejects a repeated --agent instead of folding it into content", async () => {
    const r = await runClient([
      "memory",
      "write",
      "hello",
      "--agent",
      "anvil",
      "--agent",
      "flint",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--agent may only be given once");
    expect(r.stderr).not.toContain("no private key found");
  });

  it("POSITIVE: --agent passes the guard and names that agent at the key load", async () => {
    const r = await runClient(["memory", "write", "hello", "--agent", "anvil"]);
    expect(r.exitCode).toBe(1); // no key in the empty temp dir, as designed
    expect(r.stderr).toContain("no private key found for agent 'anvil'");
  });

  it("POSITIVE: FLAIR_AGENT_ID passes the guard for the env source too", async () => {
    const r = await runClient(["memory", "write", "hello"], { FLAIR_AGENT_ID: "anvil" });
    expect(r.stderr).toContain("no private key found for agent 'anvil'");
    expect(r.stderr).not.toContain("refusing");
  });

  // #1851: a read signs too, so it refuses exactly like a mutation. The
  // no-network proof lives in flair-client-identity-required-1851.test.ts.
  it("NEGATIVE: read-only actions refuse without an identity too", async () => {
    for (const args of [
      ["memory", "get", "flint-1"],
      ["memory", "list"],
      ["memory", "search", "deploy"],
    ]) {
      const r = await runClient(args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`refusing to ${args[1]!}`);
      expect(r.stderr).not.toContain("no private key found");
    }
  });

  it("END-TO-END: --agent is consumed, and the signed write carries that identity", async () => {
    // The real boundary of a CLI that signs and PUTs: a recording HTTP server.
    // The 32-byte seed is arbitrary — any seed is a valid Ed25519 private key,
    // and FLAIR_PRIV_KEY wins outright over the probe paths, so no ambient key
    // file can interfere.
    const received: Array<{ method: string; url: string; auth: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({
          method: req.method,
          url: new URL(req.url).pathname,
          auth: req.headers.get("authorization") ?? "",
          body: await req.json().catch(() => null),
        });
        return Response.json({ ok: true });
      },
    });
    const keyFile = join(emptyHome, "seed.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7));
    try {
      const r = await runClient(["memory", "write", "hi", "--agent", "anvil"], {
        FLAIR_URL: `http://127.0.0.1:${server.port}`,
        FLAIR_PRIV_KEY: keyFile,
      });
      expect(r.exitCode).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe("PUT");
      expect(received[0]!.auth).toContain("TPS-Ed25519 anvil:");
      // The flag was consumed by the identity parser, not folded into content.
      const body = received[0]!.body as { agentId: string; content: string };
      expect(body.agentId).toBe("anvil");
      expect(body.content).toBe("hi");
    } finally {
      server.stop(true);
    }
  });
});
