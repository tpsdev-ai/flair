/**
 * doctor-idp-mappings-cli.test.ts — `flair doctor`'s IdP mappings section,
 * driven through the REAL built CLI (`dist/cli.js`) against a REAL spawned
 * Harper.
 *
 * Same isolation as test/integration/doctor-agent-id-rule-cli-2359.test.ts:
 * startHarper() runs from a mkdtemp install dir on OS-assigned ports (never
 * ~/.flair, never port 9926), and the CLI runs with HOME pointed at a separate
 * mktemp dir.
 *
 * The section reads every idp row and its audit entries
 * (src/lib/idp-mapping-audit.ts). This file proves, through the CLI's output,
 * issue count and exit status:
 *   1. a mapping the linker (`flair mcp enable` / `flair principal link`)
 *      created and one an admin agent created over REST are the clear result
 *      and add no issue;
 *   2. a row whose history does not show its creation is reported as
 *      unattributed and counted, and running the re-stamp command doctor
 *      prints makes the next run clear;
 *   3. a row the shared non-admin agent user (`flair-agent`) inserted is
 *      listed with its principal and provider, without its subject, and
 *      counted, and running the revoke command doctor prints makes the next
 *      run clear.
 *
 * The exit status is compared with a run that holds no mapping. The sandbox
 * HOME carries a registered agent key and the data directory a local install
 * has, so that run is clean except where the platform adds an issue: on macOS
 * the sandbox install is not under launchd, which doctor counts, so both runs
 * exit 1 there. Where the baseline is clean, the mapping runs must exit 0.
 *
 * The printed commands run with `bash -c`, with the test instance's admin
 * password inserted after the user name where curl would prompt for it.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { provisionIdpIdentityMapping } from "../../src/lib/mcp-enable";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass
const CLEAR = "No active IdP mapping row's audit history shows a non-admin agent's mapping write";
const sfx = randomUUID().slice(0, 8);

let harper: HarperInstance;
let cliHome: string;

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

/** Run `flair doctor` against this test's instance, with an isolated HOME. */
function runDoctor(): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = ["doctor", "--port", new URL(harper.httpURL).port];
    const startedAt = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: cliHome,
        FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: new URL(harper.opsURL).port,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: ADMIN_PASS,
        NO_COLOR: "1",
      },
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 20_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** The issue count doctor prints in its summary line ("N issues found"). */
function issueCount(stdout: string): number {
  if (/No issues found/.test(stdout)) return 0;
  const m = stdout.match(/(\d+) issues? found/);
  if (!m) throw new Error(`no summary line in doctor output:\n${stdout}`);
  return Number(m[1]);
}

/** The IdP mappings section of doctor's output. */
function idpSection(stdout: string): string {
  const start = stdout.indexOf("IdP mappings");
  expect(start, `no IdP mappings section:\n${stdout}`).toBeGreaterThanOrEqual(0);
  const rest = stdout.slice(start);
  const next = rest.slice("IdP mappings".length).search(/\n\s*\n/);
  return next < 0 ? rest : rest.slice(0, next + "IdP mappings".length);
}

/** The one printed command in `section` whose text contains `marker`. */
function printedCommand(section: string, marker: string): string {
  const commands = section.split("\n").filter((l) => l.includes("curl -su ")).map((l) => l.slice(l.indexOf("curl -su ")));
  const matching = commands.filter((c) => c.includes(marker));
  expect(matching.length, `one printed command containing ${marker}:\n${section}`).toBe(1);
  return matching[0];
}

/** Run a printed command, with this instance's admin password where curl would prompt for it. */
function runPrinted(command: string): string {
  const user = harper.admin.username;
  expect(command).toContain(`curl -su ${user} `);
  expect(command).toContain(` ${harper.opsURL.replace(/\/?$/, "/")} `);
  const res = spawnSync("bash", ["-c", command.replace(`curl -su ${user} `, `curl -su ${user}:${harper.admin.password} `)], { encoding: "utf-8", timeout: 20_000 });
  expect(res.status, `printed command failed: ${res.stderr}`).toBe(0);
  return res.stdout;
}

async function opsAs(user: string, pass: string, op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${user}:${pass}`) },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} as ${user} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return text.length ? JSON.parse(text) : null;
}
const asAdmin = (op: Record<string, unknown>) => opsAs(harper.admin.username, harper.admin.password, op);

// An admin agent, for the REST-created mapping.
const ADM = { id: `idp-cli-admin-${sfx}`, ...(() => {
  const kp = nacl.sign.keyPair();
  return { publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
})() };

async function signedAsAdmin(method: string, path: string, body: unknown): Promise<number> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${ADM.id}:${ts}:${nonce}:${method}:${path}`), ADM.secretKey);
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: `TPS-Ed25519 ${ADM.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  await res.text();
  return res.status;
}

const PRINCIPALS = [`idp-cli-linked-${sfx}`, `idp-cli-rest-${sfx}`, `idp-cli-other-${sfx}`];

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-idp-doctor-home-"));
  // The directories a local install has, so the no-mapping baseline is as clean as the platform allows.
  await mkdir(join(cliHome, ".flair", "keys"), { recursive: true });
  await mkdir(join(cliHome, ".flair", "data"), { recursive: true });
  // The admin agent's signing key, registered below, as `flair init` writes one (a raw 32-byte seed).
  const keyPath = join(cliHome, ".flair", "keys", `${ADM.id}.key`);
  await writeFile(keyPath, Buffer.from(ADM.secretKey.slice(0, 32)));
  await chmod(keyPath, 0o600);
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
  const now = new Date().toISOString();
  await asAdmin({
    operation: "insert", table: "Agent",
    records: [
      { id: ADM.id, name: ADM.id, kind: "agent", type: "agent", role: "admin", admin: true, status: "active", publicKey: ADM.publicKey, createdAt: now, updatedAt: now, originatorInstanceId: "inst-fixture-idp-cli" },
      ...PRINCIPALS.map((id) => ({ id, name: id, kind: "agent", type: "agent", role: "agent", status: "active", publicKey: `idp-cli-${id}`, createdAt: now, updatedAt: now, originatorInstanceId: "inst-fixture-idp-cli" })),
    ],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("flair doctor — the IdP mappings section (real CLI + real spawned Harper)", () => {
  test("linker and admin REST mappings are clear; an unattributed row and a non-admin agent's mapping are counted until their printed remedy runs", async () => {
    // 0. No mapping: the baseline count and exit status.
    const base = await runDoctor();
    expect(base.stderr, base.stderr).toBe("");
    expect(idpSection(base.stdout)).toContain("No IdP mapping rows are stored");
    const baseCount = issueCount(base.stdout);
    expect(base.code).toBe(baseCount === 0 ? 0 : 1);

    // 1. A mapping the linker created and one an admin agent created over REST.
    const opsPort = Number(new URL(harper.opsURL).port);
    await provisionIdpIdentityMapping({
      opsPortOrUrl: opsPort, adminUser: harper.admin.username, adminPass: harper.admin.password,
      principal: PRINCIPALS[0], principalKind: "agent", idpProvider: "github", idpSubject: `sub-linked-${sfx}`,
    });
    const restRow = `cred-idp-cli-rest-${sfx}`;
    expect([200, 201, 204]).toContain(await signedAsAdmin("PUT", `/Credential/${restRow}`, { id: restRow, principalId: PRINCIPALS[1], kind: "idp", idpProvider: "mcp-oauth", idpSubject: `sub-rest-${sfx}` }));
    const clear = await runDoctor();
    const clearSection = idpSection(clear.stdout);
    expect(clearSection).toContain(CLEAR);
    expect(clearSection).toContain("(2 active of 2 stored)");
    expect(clearSection).not.toContain("cannot be attributed");
    expect(clearSection).not.toContain("row(s) written by a non-admin agent");
    expect(issueCount(clear.stdout), "the linker and admin REST mappings moved the summary").toBe(baseCount);
    expect(clear.code).toBe(base.code);

    // 2. A row whose recorded write carries an older creation time, as a row
    //    copied in from elsewhere does: its history does not show its creation.
    const copied = `cred-idp-cli-copied-${sfx}`;
    const copiedSub = `sub-copied-${sfx}`;
    await asAdmin({ operation: "upsert", table: "Credential", records: [{ id: copied, principalId: PRINCIPALS[2], kind: "idp", idpProvider: "mcp-oauth", idpSubject: copiedSub, status: "active", createdAt: "2026-01-01T00:00:00.000Z" }] });
    const unattributed = await runDoctor();
    const unattributedSection = idpSection(unattributed.stdout);
    expect(unattributedSection).toContain(`1 IdP mapping row(s) cannot be attributed`);
    expect(unattributedSection).toContain(copied);
    expect(unattributedSection).not.toContain(copiedSub);
    expect(unattributedSection, "an unattributed row was reported as clear").not.toContain(CLEAR);
    expect(issueCount(unattributed.stdout), "the unattributed row did not move the summary").toBe(baseCount + 1);
    expect(unattributed.code).toBe(1);
    // The printed re-stamp clears it.
    expect(runPrinted(printedCommand(unattributedSection, '"createdAt":'))).toContain("updated 1 of 1");
    const restamped = await runDoctor();
    expect(idpSection(restamped.stdout)).toContain(CLEAR);
    expect(idpSection(restamped.stdout)).toContain("(3 active of 3 stored)");
    expect(issueCount(restamped.stdout), "the re-stamped row still moved the summary").toBe(baseCount);
    expect(restamped.code).toBe(base.code);

    // 3. A mapping inserted as the shared non-admin agent Harper user (the user
    //    a non-admin agent's REST write runs as), with a password this test
    //    sets on its own instance.
    const agentPass = `idp-doctor-${randomUUID()}`;
    await asAdmin({ operation: "alter_user", username: "flair-agent", password: agentPass, active: true, role: "flair_agent" });
    const written = `cred-idp-cli-agent-${sfx}`;
    const writtenSub = `sub-agent-${sfx}`;
    await opsAs("flair-agent", agentPass, { operation: "insert", table: "Credential", records: [{ id: written, principalId: "principal-agent", kind: "idp", idpProvider: "mcp-oauth", idpSubject: writtenSub, status: "active", createdAt: new Date().toISOString() }] });
    const listed = await runDoctor();
    const listedSection = idpSection(listed.stdout);
    expect(listedSection).toContain(
      `1 IdP mapping row(s) written by a non-admin agent (from the audit log): ${written} (principal 'principal-agent', provider 'mcp-oauth')`,
    );
    expect(listedSection).not.toContain(writtenSub);
    expect(listedSection).not.toContain(CLEAR);
    expect(issueCount(listed.stdout), "the non-admin mapping did not move the summary").toBe(baseCount + 1);
    expect(listed.code).toBe(1);
    // The printed revoke clears it: a revoked row maps nobody and is not checked.
    expect(runPrinted(printedCommand(listedSection, '"status":"revoked"'))).toContain("updated 1 of 1");
    const revoked = await runDoctor();
    expect(idpSection(revoked.stdout)).toContain(CLEAR);
    expect(idpSection(revoked.stdout)).toContain("(3 active of 4 stored)");
    expect(issueCount(revoked.stdout), "the revoked row still moved the summary").toBe(baseCount);
    expect(revoked.code).toBe(base.code);
  }, 180_000);
});
