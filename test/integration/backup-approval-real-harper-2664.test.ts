/**
 * backup-approval-real-harper-2664.test.ts — flair#2664 slices 1b and 1c
 * against a REAL Harper and the REAL built CLI.
 *
 * One Harper is started with startHarper, which assigns its HTTP and
 * operations ports independently. The setup restarts it until the operations
 * port is not the HTTP port minus one and nothing listens on the HTTP port
 * minus one, and asserts both: a CLI that derived the operations port from
 * the HTTP port would reach no operations API, so every case below fails.
 * Every CLI call names this instance explicitly (`--port`, `--ops-port`, or
 * `--url` and `--ops-target`) and runs with a throwaway HOME, so the approval
 * store is `<HOME>/.flair/approved-archives`.
 * The admin password is read from a 0600 credential file.
 *
 * Operator credentials (`flair backup-approval approve`), through Harper's
 * real `user_info`: accepted super_user credentials approve and record the
 * verified user; refused credentials approve nothing; a wrong operations port
 * refuses with an error that names the port and --ops-port.
 *
 * Legacy admission round trip: a real `flair backup` of one agent, its sidecar
 * removed, is refused by `flair restore`; `legacy-admit` with the confirmed
 * digest approves it; `flair restore` then writes from the approved copy. The
 * Memory row (deleted since the backup) is re-created and the Soul row
 * (changed since the backup) is restored, and restore verifies both. The
 * Agent row is refused by its admin PUT with HTTP 400 at this head, so
 * restore exits non-zero with that one error: Agent.put drops `createdAt`
 * and `publicKey` and the full-row PUT then fails schema validation
 * (flair#2703, independent of this change). The test asserts that outcome
 * rather than a clean exit.
 *
 * Archived promotion verdicts: restoring a promoted Memory needs the server
 * writer of slice 2. Until then the authority-field guard refuses the admin
 * PUT of a row that is absent from the store, and restore reports that row
 * as failed (HTTP 403) and exits non-zero while the other rows restore.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { nodeBin } from "../helpers/node-runtime";
import { tempDir } from "../helpers/temp-dir";
import { HARPER_START_BUDGET_MS, HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { loadApprovedArchive } from "../../src/lib/backup-approval-store";
import { promotionContentHash } from "../../src/lib/promotion-content-hash";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "restore-2664-agent";
const SOUL_ID = `${AGENT_ID}:identity`;
const MEMORY_ID = "restore-2664-memory";
const PROMOTED_ID = "restore-2664-promoted";
const CREATED_AT = "2026-10-01T00:00:00.000Z";

let harper: HarperInstance;
let running: HarperInstance | undefined;
let httpPort: string;
let opsPort: string;
let passFile: string;
let wrongPassFile: string;
let secrets: string | undefined;

interface RunResult { code: number | null; stdout: string; stderr: string }

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!h.process?.pid || !h.installDir.startsWith(tmpdir())) throw new Error("refusing to run: not an instance this test started");
}

/** Run the built CLI with a throwaway HOME and no ambient Flair settings. */
function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const env = { ...ambient, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...extraEnv } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`flair ${args[0]} ${args[1] ?? ""} ended by ${signal}: ${stdout}${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function op(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status, `ops ${body.operation}`).toBe(200);
  return res.json();
}

async function operatorPut(path: string, body: unknown): Promise<number> {
  const res = await fetch(harper.httpURL + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await res.text();
  return res.status;
}

const row = async (table: string, id: string): Promise<any> =>
  (await op({ operation: "search_by_id", database: "flair", table, ids: [id], get_attributes: ["*"] }))[0];

/** Whether something accepts TCP connections on 127.0.0.1:`port`. */
function accepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2_000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A real `flair backup` of the test agent; returns the archive path. */
async function backup(home: string, name: string): Promise<string> {
  const output = join(tempDir("flair-2664-real-archive-"), name);
  const result = await runCli([
    "backup", "--url", harper.httpURL, "--ops-target", harper.opsURL, "--admin-pass-file", passFile,
    "--agents", AGENT_ID, "--output", output,
  ], home);
  expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
  expect(existsSync(`${output}.sha256`)).toBe(true);
  return output;
}

const sha256Of = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const credentials = () => ["--port", httpPort, "--ops-port", opsPort, "--admin-pass-file", passFile];

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  for (let attempt = 1; ; attempt++) {
    harper = await startHarper();
    running = harper;
    assertOwnInstance(harper);
    const http = Number(new URL(harper.httpURL).port);
    const ops = Number(new URL(harper.opsURL).port);
    if (ops !== http - 1 && !(await accepting(http - 1))) break;
    await stopHarper(harper);
    running = undefined;
    if (attempt === 5) throw new Error("could not start Harper with nothing on its HTTP port minus one after 5 attempts");
  }
  httpPort = new URL(harper.httpURL).port;
  opsPort = new URL(harper.opsURL).port;
  expect(Number(opsPort)).not.toBe(Number(httpPort) - 1);
  expect(await accepting(Number(httpPort) - 1)).toBe(false);
  // Lives for the whole file, so it is not a per-test tempDir (which is swept after each test).
  secrets = mkdtempSync(join(tmpdir(), "flair-2664-real-secrets-"));
  passFile = join(secrets, "admin-pass");
  writeFileSync(passFile, `${harper.admin.password}\n`, { mode: 0o600 });
  chmodSync(passFile, 0o600);
  wrongPassFile = join(secrets, "wrong-pass");
  writeFileSync(wrongPassFile, "not-the-admin-password\n", { mode: 0o600 });
  chmodSync(wrongPassFile, 0o600);

  const keys = nacl.sign.keyPair();
  await op({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: AGENT_ID, name: "Restore Agent", role: "agent", publicKey: Buffer.from(keys.publicKey).toString("base64"), createdAt: CREATED_AT }],
  });
  expect(await operatorPut(`/Soul/${encodeURIComponent(SOUL_ID)}`, {
    id: SOUL_ID, agentId: AGENT_ID, key: "identity", value: "The agent that the restore round trip brings back", createdAt: CREATED_AT,
  })).toBeLessThan(300);
  expect(await operatorPut(`/Memory/${MEMORY_ID}`, {
    id: MEMORY_ID, agentId: AGENT_ID, content: "An ordinary note kept across backup and restore", durability: "persistent", tags: ["note"], createdAt: CREATED_AT,
  })).toBeLessThan(300);
}, HARPER_START_BUDGET_MS);

afterAll(async () => {
  if (running) await stopHarper(running);
  if (secrets) rmSync(secrets, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair backup-approval verifies operator credentials with the real operations API (#2664)", () => {
  test("accepted super_user credentials from a credential file approve, recording the verified user", async () => {
    const home = tempDir("flair-2664-real-home-");
    const archive = await backup(home, "approve.json");
    const result = await runCli(["backup-approval", "approve", archive, ...credentials()], home);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const loaded = loadApprovedArchive(sha256Of(archive), { root: join(home, ".flair", "approved-archives") });
    expect(loaded).toMatchObject({ ok: true, record: { admission: "sidecar", approvedBy: harper.admin.username } });
  }, 120_000);

  test("refused credentials approve nothing and leave the store unchanged", async () => {
    const home = tempDir("flair-2664-real-home-");
    const archive = await backup(home, "refused.json");
    const result = await runCli(["backup-approval", "approve", archive, "--port", httpPort, "--ops-port", opsPort, "--admin-pass-file", wrongPassFile], home);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/the operator credentials were refused by this host's operations API \(HTTP 40[13]\); nothing was approved/);
    expect(result.stderr).not.toContain("not-the-admin-password");
    expect(existsSync(join(home, ".flair", "approved-archives"))).toBe(false);
  }, 120_000);

  test("a wrong operations port refuses with an error naming the port and --ops-port", async () => {
    const home = tempDir("flair-2664-real-home-");
    const archive = await backup(home, "wrong-port.json");
    const wrong = String(await closedPort());
    const result = await runCli(["backup-approval", "approve", archive, "--port", httpPort, "--ops-port", wrong, "--admin-pass-file", passFile], home);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`could not reach this host's operations API at http://127.0.0.1:${wrong}`);
    expect(result.stderr).toContain("--ops-port (or FLAIR_OPS_PORT)");
    expect(result.stderr).toContain("nothing was approved");
    expect(existsSync(join(home, ".flair", "approved-archives"))).toBe(false);
  }, 120_000);
});

describe("an archive without a sidecar restores through legacy admission (#2664)", () => {
  test("refused without an approval, approved with the confirmed digest, then Memory and Soul restored and verified from the approved copy (the Agent PUT fails, flair#2703)", async () => {
    const home = tempDir("flair-2664-real-home-");
    const archive = await backup(home, "legacy.json");
    const archived = JSON.parse(readFileSync(archive, "utf8"));
    expect(archived.memories.map((m: any) => m.id)).toEqual([MEMORY_ID]);
    rmSync(`${archive}.sha256`);
    const digest = sha256Of(archive);

    await op({ operation: "delete", database: "flair", table: "Memory", ids: [MEMORY_ID] });
    await op({ operation: "upsert", database: "flair", table: "Soul", records: [{ id: SOUL_ID, value: "Changed since the backup" }] });
    await op({ operation: "upsert", database: "flair", table: "Agent", records: [{ id: AGENT_ID, name: "Renamed since the backup" }] });
    expect(await row("Memory", MEMORY_ID)).toBeUndefined();

    const restoreArgs = ["restore", archive, "--url", harper.httpURL];
    const restoreEnv = { FLAIR_ADMIN_PASS: harper.admin.password };
    const refused = await runCli(restoreArgs, home, restoreEnv);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`flair backup-approval legacy-admit ${archive}`);
    expect(refused.stderr).toContain("restore stopped before any write");
    expect(await row("Memory", MEMORY_ID)).toBeUndefined();

    const shown = await runCli(["backup-approval", "legacy-admit", archive], home);
    expect(shown.code).not.toBe(0);
    expect(shown.stdout).toContain(digest);
    const admitted = await runCli(["backup-approval", "legacy-admit", archive, "--confirm-digest", digest, ...credentials()], home);
    expect(admitted.stderr).toBe("");
    expect(admitted.code).toBe(0);

    const restored = await runCli(restoreArgs, home, restoreEnv);
    expect(restored.stdout).toContain(`Archive SHA-256: ${digest} (no digest sidecar; approved on this host by ${harper.admin.username}`);
    // The only error is the Agent PUT (flair#2703); every Soul and Memory row
    // was written and passed restore's read-back verification.
    expect(restored.stderr).toBe(`Error: Agent ${AGENT_ID} (agent ${AGENT_ID}): PUT failed (HTTP 400)\n`);
    expect(restored.code).toBe(1);
    expect(restored.stdout).not.toContain("Restore complete");

    expect(await row("Agent", AGENT_ID)).toMatchObject({ id: AGENT_ID, name: "Renamed since the backup" });
    expect(await row("Soul", SOUL_ID)).toMatchObject({ agentId: AGENT_ID, key: "identity", value: "The agent that the restore round trip brings back" });
    expect(await row("Memory", MEMORY_ID)).toMatchObject({
      agentId: AGENT_ID, content: "An ordinary note kept across backup and restore", durability: "persistent", tags: ["note"], createdAt: CREATED_AT,
    });
  }, 300_000);

  test("an archived promotion verdict waits for the slice 2 writer: that row is refused (HTTP 403) and restore exits non-zero", async () => {
    const content = "A reviewed lesson with an approved verdict";
    await op({
      operation: "upsert", database: "flair", table: "Memory",
      records: [{
        id: PROMOTED_ID, agentId: AGENT_ID, content, durability: "persistent", createdAt: CREATED_AT,
        promotionStatus: "approved", promotedAt: "2026-10-02T00:00:00.000Z", promotedBy: "reviewer", promotionContentHash: promotionContentHash(content),
      }],
    });
    const home = tempDir("flair-2664-real-home-");
    const archive = await backup(home, "promoted.json");
    const archived = JSON.parse(readFileSync(archive, "utf8"));
    expect(archived.memories.find((m: any) => m.id === PROMOTED_ID)).toMatchObject({ promotionStatus: "approved", promotionContentHash: promotionContentHash(content) });
    rmSync(`${archive}.sha256`);
    const digest = sha256Of(archive);
    await op({ operation: "delete", database: "flair", table: "Memory", ids: [PROMOTED_ID] });

    const admitted = await runCli(["backup-approval", "legacy-admit", archive, "--confirm-digest", digest, ...credentials()], home);
    expect(admitted.code).toBe(0);
    const restored = await runCli(["restore", archive, "--url", harper.httpURL], home, { FLAIR_ADMIN_PASS: harper.admin.password });
    expect(restored.code).toBe(1);
    expect(restored.stdout).not.toContain("Restore complete");
    expect(restored.stderr.trimEnd().split("\n").sort()).toEqual([
      `Error: Agent ${AGENT_ID} (agent ${AGENT_ID}): PUT failed (HTTP 400)`,
      `Error: Memory ${PROMOTED_ID} (agent ${AGENT_ID}): GET failed (HTTP 404): verification failed`,
      `Error: Memory ${PROMOTED_ID} (agent ${AGENT_ID}): PUT failed (HTTP 403)`,
    ].sort());
    expect(await row("Memory", PROMOTED_ID)).toBeUndefined();
    expect(await row("Memory", MEMORY_ID)).toMatchObject({ content: "An ordinary note kept across backup and restore" });
    expect(await row("Soul", SOUL_ID)).toMatchObject({ value: "The agent that the restore round trip brings back" });
  }, 300_000);
});
