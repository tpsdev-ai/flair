/**
 * status-federation-spoke-peers-1146.test.ts — flair#1146 against a REAL Harper.
 *
 * `flair status --json` is a pass-through of `/HealthDetail`. #1499 already
 * made `connected` mean lastSyncAt-within-24h (the 0.40.0 symptom was
 * `status === "connected"`, a value pairing never writes). This suite is
 * the fails-first pin that HealthDetail names that measure
 * (`measuredBy: "lastSyncAt"`) and that a missing stamp stays unknown —
 * not inferred from any other freshness.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64"),
    },
    body: JSON.stringify(op),
  });
}

function basicAuth(harper: HarperInstance): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function cliEnv(harper: HarperInstance, home: string): Record<string, string | undefined> {
  return {
    HOME: home,
    FLAIR_ADMIN_PASS: harper.admin.password,
    HDB_ADMIN_PASSWORD: undefined,
    FLAIR_AGENT_ID: undefined,
    FLAIR_TOKEN: undefined,
    FLAIR_TARGET: undefined,
    FLAIR_URL: undefined,
    FLAIR_OUTPUT: undefined,
  };
}

async function statusJson(harper: HarperInstance, home: string): Promise<any> {
  const { stdout, stderr, exitCode } = await runCli(
    ["status", "--target", harper.httpURL, "--json"],
    cliEnv(harper, home),
  );
  expect(exitCode, `status --json failed\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
  return JSON.parse(stdout);
}

let harper: HarperInstance;
let tmpHome: string;
const lastSyncAt = new Date().toISOString();
const hubPeerId = "flair_hub_1146";
const spokePeerId = "flair_spoke_1146";

describe("flair#1146 status --json federation.peers on a real instance", () => {
  beforeAll(async () => {
    harper = await startHarper();
    tmpHome = makeTmpDir("flair-1146-home");
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });

    const instRes = await fetch(`${harper.httpURL}/FederationInstance`, {
      headers: { Authorization: basicAuth(harper) },
    });
    expect(instRes.ok, `FederationInstance: ${instRes.status} ${await instRes.text()}`).toBe(true);

    const hubKp = nacl.sign.keyPair();
    const spokeKp = nacl.sign.keyPair();
    const now = new Date().toISOString();

    // Spoke-shaped local view of the hub: pairing writes `paired` and, after
    // a successful push, lastSyncAt is the contact stamp HealthDetail counts.
    const hubPeer = await adminOp(harper, {
      operation: "upsert",
      database: "flair",
      table: "Peer",
      records: [{
        id: hubPeerId,
        publicKey: Buffer.from(hubKp.publicKey).toString("base64url"),
        role: "hub",
        endpoint: "https://hub.example",
        status: "paired",
        lastSyncAt,
        relayOnly: false,
        pairedAt: now,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(hubPeer.status, `hub Peer upsert: ${hubPeer.status} ${await hubPeer.text()}`).toBe(200);

    // Hub-shaped local view of a spoke — must not regress to connected: 0.
    const spokePeer = await adminOp(harper, {
      operation: "upsert",
      database: "flair",
      table: "Peer",
      records: [{
        id: spokePeerId,
        publicKey: Buffer.from(spokeKp.publicKey).toString("base64url"),
        role: "spoke",
        endpoint: "https://spoke.example",
        status: "connected",
        lastSyncAt,
        relayOnly: false,
        pairedAt: now,
        createdAt: now,
        updatedAt: now,
      }],
    });
    expect(spokePeer.status, `spoke Peer upsert: ${spokePeer.status} ${await spokePeer.text()}`).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("HealthDetail and status --json agree: both peers with lastSyncAt count as connected", async () => {
    const healthRes = await fetch(`${harper.httpURL}/HealthDetail`, {
      headers: { Authorization: basicAuth(harper) },
      signal: AbortSignal.timeout(5_000),
    });
    expect(healthRes.ok).toBe(true);
    const health = await healthRes.json() as any;
    expect(health.federation?.peers?.measuredBy, "HealthDetail must name what connected measures").toBe("lastSyncAt");
    expect(health.federation.peers.total).toBe(2);
    expect(health.federation.peers.connected).toBe(2);
    expect(health.federation.peers.disconnected).toBe(0);
    expect(health.federation.peers.unknown).toBe(0);

    const out = await statusJson(harper, tmpHome);
    expect(out.federation.peers.measuredBy).toBe("lastSyncAt");
    expect(out.federation.peers.total).toBe(2);
    expect(out.federation.peers.connected).toBe(2);
    expect(out.federation.peers.disconnected).toBe(0);
    expect(out.federation.peers.revoked).toBe(0);
    expect(out.federation.peers.unknown).toBe(0);
  }, 30_000);

  test("hazard: wiping lastSyncAt does NOT become connected via some other freshness", async () => {
    const clearHub = await adminOp(harper, {
      operation: "update",
      database: "flair",
      table: "Peer",
      records: [{ id: hubPeerId, lastSyncAt: "" }],
    });
    expect(clearHub.ok, `clear lastSyncAt: ${clearHub.status}`).toBe(true);

    const out = await statusJson(harper, tmpHome);
    expect(out.federation.peers.measuredBy).toBe("lastSyncAt");
    // One peer still has lastSyncAt (the hub-shaped spoke row). The wiped
    // hub row is unknown — not connected.
    expect(out.federation.peers.connected).toBe(1);
    expect(out.federation.peers.unknown).toBeGreaterThanOrEqual(1);
    expect(out.federation.peers.connected + out.federation.peers.disconnected + out.federation.peers.revoked + out.federation.peers.unknown).toBe(out.federation.peers.total);
  }, 30_000);
});
