// probe-instance.test.ts — Integration tests for probeInstance (src/probe.ts,
// flair#635) against a REAL spawned Harper instance.
//
// Confirms the whole real round trip: /Health answers, an authenticated GET
// /HealthDetail succeeds, and the reported `version` field — resources/
// health.ts's resolveVersion(), which reads the RUNNING process's own
// package.json (see config.yaml: jsResource files are dist/resources/*.js,
// so this proves the compiled output, not just the TS source, reports the
// right version) — is exactly what a version-mismatch check needs.
//
// Auth here is a real TPS-Ed25519 header built directly (same pattern as
// test/integration/gate4-authgate.test.ts), NOT routed through the CLI's
// api(). probeInstance takes credential resolution as an injected
// `authedGet` and never resolves credentials itself — this test exercises
// probeInstance in isolation from whichever resolution path (env var, agent
// key, admin-pass file) a given caller ends up using. #636 (Fabric fleet
// verify) will inject a completely different authedGet (Fabric admin Basic
// auth per peer) against the exact same probeInstance.
//
// HOME isolation note: harper-lifecycle.ts's startHarper() sets HOME in the
// spawned Harper's OWN child-process env — it never mutates
// process.env.HOME in this test process itself. This test does not touch
// HOME at all (it never reads ~/.flair/admin-pass or any other real local
// file), so there's nothing to isolate here beyond what startHarper already
// does for the Harper child process.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { probeInstance } from "../../src/probe";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

let harper: HarperInstance;
const agent = mkAgent("probe-instance-agent");
let realVersion: string;

describe("probeInstance against a real spawned Harper (flair#635)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(res.status, `Agent insert returned ${res.status}: ${await res.text()}`).toBe(200);

    // Read the SAME package.json resources/health.ts's resolveVersion() will
    // find (repo root — see config.yaml's dist/resources/*.js jsResource
    // config) instead of hardcoding a version string that drifts on release.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    realVersion = pkg.version;
    expect(typeof realVersion).toBe("string");
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  function authedGet(path: string): Promise<any> {
    return fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    }).then(async (res) => {
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      return text ? JSON.parse(text) : {};
    });
  }

  test("healthy + authenticated + correct version → ok", async () => {
    const result = await probeInstance(harper.httpURL, {
      expectVersion: realVersion,
      timeoutMs: 15_000,
      authedGet,
    });
    expect(result.healthy, JSON.stringify(result)).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe(realVersion);
    expect(result.versionMatch).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  }, 30_000);

  test("a wrong expected version is detected as a mismatch, not a false pass", async () => {
    const result = await probeInstance(harper.httpURL, {
      expectVersion: "999.999.999-definitely-not-installed",
      timeoutMs: 15_000,
      authedGet,
    });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe(realVersion);
    expect(result.versionMatch).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("version mismatch");
    expect(result.error).toContain(realVersion);
  }, 30_000);

  test("credential-less authedGet is rejected (HealthDetail is allowVerified, not public)", async () => {
    const result = await probeInstance(harper.httpURL, {
      expectVersion: realVersion,
      timeoutMs: 15_000,
      authedGet: async (path) => {
        const res = await fetch(`${harper.httpURL}${path}`);
        const text = await res.text();
        if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
        return text ? JSON.parse(text) : {};
      },
    });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.version).toBeNull();
    expect(result.ok).toBe(false);
  }, 30_000);

  test("health-only probe (no authedGet) reports healthy without attempting auth", async () => {
    const result = await probeInstance(harper.httpURL, { timeoutMs: 15_000 });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBeNull();
    expect(result.version).toBeNull();
    expect(result.ok).toBe(true);
  }, 30_000);
});
