// principal-disable-missing-status-2272.test.ts — flair#2272.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const sfx = Date.now().toString(36);

interface Principal { id: string; publicKey: string; secretKey: Uint8Array }

function mkPrincipal(id: string): Principal {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

// Seed: created through the real POST /AgentSeed path, left with no `status`.
const seed = mkPrincipal(`p2272-seed-${sfx}`);
// Explicit: written with `status: "active"`.
const explicit = mkPrincipal(`p2272-explicit-${sfx}`);
const basicUser = `p2272-basic-${sfx}`;
const basicPass = "p2272-basic-test-password";

let harper: HarperInstance;
let scratch: string;

function basicHeader(): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicHeader() },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(10_000),
  });
}

async function expectOk(res: Response, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status, `${what} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
}

/** The stored Agent row exactly as written (a missing `status` is absent, not null). */
async function rawRow(id: string): Promise<any> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "Agent",
    search_attribute: "id", search_type: "equals", search_value: id,
  });
  const rows = await res.json();
  expect(Array.isArray(rows) && rows.length, `no Agent row for ${id}`).toBeTruthy();
  return (rows as any[])[0];
}

/** A signed Ed25519 GET against this test's own HTTP port. */
function signedGet(principal: Principal, path: string): Promise<Response> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${principal.id}:${ts}:${nonce}:GET:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), principal.secretKey);
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: `TPS-Ed25519 ${principal.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
}

function protectedGet(): Promise<Response> {
  return fetch(`${harper.httpURL}/Memory/?agentId=${basicUser}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd: env.HOME ?? scratch,
      env: { ...process.env, FLAIR_AGENT_ID: "", FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "", FLAIR_ADMIN_PASS: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

const opsPort = () => Number(new URL(harper.opsURL).port);
const httpPort = () => Number(new URL(harper.httpURL).port);
const adminPass = () => harper.admin.password;

/** The line of a table/list/show output that names `id`. */
function lineFor(output: string, id: string): string | undefined {
  return output.split("\n").find((l) => l.includes(id));
}

describe("flair#2272 — a principal with no status is active, so disable/enable work on it", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2272-home-"));
    harper = await startHarper();

    // Talk only to this test's own ephemeral instance: loopback, the
    // OS-assigned ports it started on, never a production port, and a data
    // directory under the temp dir — checked before the first call.
    const http = new URL(harper.httpURL);
    const ops = new URL(harper.opsURL);
    for (const u of [http, ops]) {
      const port = Number(u.port);
      if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
        throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
      }
    }
    if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
      throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
    }

    // The `seed` principal through the REAL AgentSeed path (no status written),
    // then its real public key stored on the row so it can sign.
    await expectOk(await fetch(`${harper.httpURL}/AgentSeed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicHeader() },
      body: JSON.stringify({ agentId: seed.id, displayName: seed.id }),
      signal: AbortSignal.timeout(10_000),
    }), "POST /AgentSeed");
    await expectOk(await adminOp({
      operation: "update", database: "flair", table: "Agent",
      records: [{ id: seed.id, kind: "agent", publicKey: seed.publicKey, updatedAt: new Date().toISOString() }],
    }), "store the seeded principal's key");

    // The `explicit` principal with `status: "active"`.
    const now = new Date().toISOString();
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: explicit.id, name: explicit.id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: explicit.publicKey, createdAt: now, updatedAt: now }],
    }), "seed the explicit-active principal");
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  test("the AgentSeed principal really has no stored status (the shape this fix covers)", async () => {
    expect("status" in (await rawRow(seed.id)), "the seed path must not have written a status for this case to be meaningful").toBe(false);
  }, 30_000);

  test("human-readable principal show and list report the missing status as active", async () => {
    const show = await runCli(["principal", "show", seed.id], { HOME: scratch, FLAIR_URL: harper.httpURL, FLAIR_ADMIN_PASS: adminPass(), FLAIR_OUTPUT: "human" });
    expect(show.code, show.stderr).toBe(0);
    const showStatus = lineFor(show.stdout, "status");
    expect(showStatus, show.stdout).toContain("active");

    const list = await runCli(["principal", "list", "--kind", "agent", "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch, FLAIR_OUTPUT: "human" });
    expect(list.code, list.stderr).toBe(0);
    const listRow = lineFor(list.stdout, seed.id);
    expect(listRow, `no list row for ${seed.id}:\n${list.stdout}`).toBeTruthy();
    expect(listRow).toContain("active");
  }, 60_000);

  test("AgentSeed principal: disable refuses protected Ed25519 access; enable restores it", async () => {
    // Active while it has no status: the auth path treats missing as active.
    const before = await signedGet(seed, `/Agent/${seed.id}`);
    await before.arrayBuffer();
    expect(before.status, "a no-status principal authenticates while active").toBe(200);

    const disabled = await runCli(["principal", "disable", seed.id, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(disabled.code, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
    expect(disabled.stdout).toContain(`Principal '${seed.id}' deactivated`);
    expect((await rawRow(seed.id)).status).toBe("deactivated");

    const refused = await signedGet(seed, `/Agent/${seed.id}`);
    const refusedBody = await refused.text();
    expect(refused.status, `a disabled principal must not authenticate: ${refusedBody}`).toBe(401);
    expect(refusedBody).toContain("principal_deactivated");

    const enabled = await runCli(["principal", "enable", seed.id, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(enabled.code, `${enabled.stdout}\n${enabled.stderr}`).toBe(0);
    expect(enabled.stdout).toContain(`Principal '${seed.id}' activated`);
    expect((await rawRow(seed.id)).status).toBe("active");

    const restored = await signedGet(seed, `/Agent/${seed.id}`);
    await restored.arrayBuffer();
    expect(restored.status, "re-enable restores authentication").toBe(200);
  }, 90_000);

  test("no-status Basic principal: disable refuses protected access; enable restores it", async () => {
    await expectOk(await adminOp({
      operation: "add_user", username: basicUser, password: basicPass,
      role: "super_user", active: true,
    }), "add Basic user");
    await expectOk(await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: basicUser, name: basicUser, kind: "human", role: "admin", createdAt: new Date().toISOString() }],
    }), "insert no-status Basic principal");
    expect("status" in (await rawRow(basicUser))).toBe(false);

    const before = await protectedGet();
    await before.arrayBuffer();
    expect(before.status).toBe(200);

    const disabled = await runCli(["principal", "disable", basicUser, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(disabled.code, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
    expect((await rawRow(basicUser)).status).toBe("deactivated");
    const refused = await protectedGet();
    await refused.arrayBuffer();
    expect(refused.status).toBe(403);

    const enabled = await runCli(["principal", "enable", basicUser, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(enabled.code, `${enabled.stdout}\n${enabled.stderr}`).toBe(0);
    expect((await rawRow(basicUser)).status).toBe("active");
    const restored = await protectedGet();
    await restored.arrayBuffer();
    expect(restored.status).toBe(200);
  }, 90_000);

  test("a principal with an explicit active status behaves the same", async () => {
    const before = await signedGet(explicit, `/Agent/${explicit.id}`);
    await before.arrayBuffer();
    expect(before.status).toBe(200);

    const disabled = await runCli(["principal", "disable", explicit.id, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(disabled.code, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
    expect((await rawRow(explicit.id)).status).toBe("deactivated");

    const refused = await signedGet(explicit, `/Agent/${explicit.id}`);
    const refusedBody = await refused.text();
    expect(refused.status).toBe(401);
    expect(refusedBody).toContain("principal_deactivated");

    const enabled = await runCli(["principal", "enable", explicit.id, "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch });
    expect(enabled.code, `${enabled.stdout}\n${enabled.stderr}`).toBe(0);
    expect((await rawRow(explicit.id)).status).toBe("active");

    const restored = await signedGet(explicit, `/Agent/${explicit.id}`);
    await restored.arrayBuffer();
    expect(restored.status).toBe(200);
  }, 90_000);
});
