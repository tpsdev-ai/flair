import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProbeSigningIdentity } from "../../src/cli.ts";
import { ProbeAuthServer, PROBE_BASE_URL } from "../helpers/probe-auth-server.ts";

/**
 * flair#1501 — the pure identity-resolution decision behind the doctor/init
 * probes. Covers every shape doctor supports: flag, env, no-name-but-a-
 * registered-local-key, no-name-and-nothing-registered, and nothing at all.
 */

let keysDir: string;
let server: ProbeAuthServer;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-1501-resolve-"));
  server = new ProbeAuthServer();
  for (const k of ["FLAIR_AGENT_ID", "FLAIR_KEY_DIR"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // `resolveKeyPath` reads FLAIR_KEY_DIR before falling back to ~/.flair/keys.
  // Point it at THIS test's isolated dir so identity resolution cannot pick up
  // a real key installed on the host (true in CI, false on a release host).
  process.env.FLAIR_KEY_DIR = keysDir;
});

afterEach(() => {
  server.restore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(keysDir, { recursive: true, force: true });
});

describe("resolveProbeSigningIdentity — the identity shapes doctor supports", () => {
  it("uses an explicit --agent verbatim (flag wins)", async () => {
    server.writeKey(keysDir, "flint", true);
    const id = await resolveProbeSigningIdentity(PROBE_BASE_URL, "flint", keysDir);
    expect(id.agentId).toBe("flint");
    expect(id.source).toBe("flag");
    expect(id.keyPath).toContain("flint.key");
  });

  it("uses FLAIR_AGENT_ID when no --agent is given (env)", async () => {
    server.writeKey(keysDir, "flint", true);
    process.env.FLAIR_AGENT_ID = "flint";
    const id = await resolveProbeSigningIdentity(PROBE_BASE_URL, undefined, keysDir);
    expect(id.agentId).toBe("flint");
    expect(id.source).toBe("env");
  });

  it("★ picks a REGISTERED local key, not merely the first `.key` (flair#1501)", async () => {
    server.writeKey(keysDir, "aaa-stale", false); // sorts first, NOT registered
    server.writeKey(keysDir, "flint", true);
    server.install();
    const id = await resolveProbeSigningIdentity(PROBE_BASE_URL, undefined, keysDir);
    expect(id.agentId).toBe("flint");
    expect(id.source).toBe("local-registered");
  });

  it("reports no usable identity when every local key is unregistered", async () => {
    server.writeKey(keysDir, "aaa-stale", false);
    server.install();
    const id = await resolveProbeSigningIdentity(PROBE_BASE_URL, undefined, keysDir);
    expect(id.agentId).toBeNull();
    expect(id.source).toBe("none");
    expect(id.detail).toContain("aaa-stale");
  });

  it("reports no usable identity for an empty keys dir", async () => {
    server.install();
    const id = await resolveProbeSigningIdentity(PROBE_BASE_URL, undefined, keysDir);
    expect(id.agentId).toBeNull();
    expect(id.source).toBe("none");
  });
});
