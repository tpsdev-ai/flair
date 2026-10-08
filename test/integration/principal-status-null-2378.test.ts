// principal-status-null-2378.test.ts — flair#2378.
//
// `flair principal show` and `principal list` must report a principal's
// `status` the way the auth gate reads it: an explicit `null` is deactivated,
// an absent key is active. Both readers must survive the REAL wire, which is
// where this seam lives — a `get_attributes` projection on the operations API
// returns `null` for an absent column too, so the CLI must read the row as
// stored (flair#2272's failing assertion was exactly a missing-status row
// reported as deactivated by `principal list`).
//
// Every principal here is created through the REAL Harper this file starts;
// the CLI runs against it. Nothing is served by a stub.

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

// One principal per stored shape. `absent` writes no `status` key at all;
// `null` writes it as an explicit null — the shape a raw write leaves.
const absent = mkPrincipal(`p2378-absent-${sfx}`);
const nullStatus = mkPrincipal(`p2378-null-${sfx}`);
const active = mkPrincipal(`p2378-active-${sfx}`);
const deactivated = mkPrincipal(`p2378-deactivated-${sfx}`);

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

/** The stored Agent row exactly as written: a missing `status` is absent, not null. */
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
const adminPass = () => harper.admin.password;

/** The value in the `status` line of `principal show`. */
function shownStatus(stdout: string): string | undefined {
  return stdout.match(/^\s*status\s+(\S+)/m)?.[1];
}

/** The value in the `status` column of the row whose id is `id`, in `list`. */
function listedStatus(stdout: string, id: string): string | undefined {
  const line = stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === id);
  return line?.trim().split(/\s+/)[4];
}

const EXPECTED: Array<[Principal, string]> = [
  [absent, "active"],
  [nullStatus, "deactivated"],
  [active, "active"],
  [deactivated, "deactivated"],
];

describe("flair#2378 — show/list report status the way auth reads it", () => {
  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2378-home-"));
    harper = await startHarper();

    // Talk only to this test's own ephemeral instance (loopback, OS-assigned
    // ports, a data dir under the temp dir) — checked before the first call.
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

    const now = new Date().toISOString();
    for (const p of [absent, nullStatus, active, deactivated]) {
      const record: Record<string, unknown> = { id: p.id, name: p.id, kind: "agent", publicKey: p.publicKey, createdAt: now, updatedAt: now };
      if (p === nullStatus) record.status = null;
      if (p === active) record.status = "active";
      if (p === deactivated) record.status = "deactivated";
      await expectOk(await adminOp({ operation: "insert", database: "flair", table: "Agent", records: [record] }), `insert ${p.id}`);
    }
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  test("the two shapes really differ on the stored row: key absent vs key present as null", async () => {
    expect("status" in (await rawRow(absent.id)), "the absent principal must not have a stored status").toBe(false);
    expect("status" in (await rawRow(nullStatus.id)), "the null principal must carry the key").toBe(true);
    expect((await rawRow(nullStatus.id)).status).toBe(null);
  }, 30_000);

  for (const [p, expected] of EXPECTED) {
    test(`show: ${p.id} displays ${expected}`, async () => {
      const show = await runCli(["principal", "show", p.id], { HOME: scratch, FLAIR_URL: harper.httpURL, FLAIR_ADMIN_PASS: adminPass(), FLAIR_OUTPUT: "human" });
      expect(show.code, show.stderr).toBe(0);
      expect(shownStatus(show.stdout), show.stdout).toBe(expected);
    }, 60_000);
  }

  test("list: every row shape displays the status auth reads", async () => {
    const list = await runCli(["principal", "list", "--kind", "agent", "--ops-port", String(opsPort()), "--admin-pass", adminPass()], { HOME: scratch, FLAIR_OUTPUT: "human" });
    expect(list.code, list.stderr).toBe(0);
    for (const [p, expected] of EXPECTED) {
      expect(listedStatus(list.stdout, p.id), `no list row for ${p.id}:\n${list.stdout}`).toBe(expected);
    }
  }, 60_000);

  test("the reported verdict matches the gate: absent authenticates, explicit null is refused", async () => {
    const ok = await signedGet(absent, `/Agent/${absent.id}`);
    await ok.arrayBuffer();
    expect(ok.status, "an absent-status principal authenticates while active").toBe(200);

    const refused = await signedGet(nullStatus, `/Agent/${nullStatus.id}`);
    const body = await refused.text();
    expect(refused.status, `an explicit-null principal must not authenticate: ${body}`).toBe(401);
    expect(body).toContain("principal_deactivated");
  }, 60_000);
});
