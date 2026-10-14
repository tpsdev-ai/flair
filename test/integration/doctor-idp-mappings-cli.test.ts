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
 *   2. a row whose history does not start at a recorded creation is reported
 *      as unattributed and counted; the review command doctor prints returns
 *      that row and no other, and running the printed re-stamp makes the next
 *      run clear;
 *   3. a row the shared non-admin agent user (`flair-agent`) inserted is
 *      listed with its principal and provider, without its subject, and
 *      counted, and running the revoke command doctor prints makes the next
 *      run clear;
 *   4. an administrator's ordinary update (a label edit) after a non-admin
 *      subject change leaves that change listed and counted; the printed
 *      review returns that row alone, and the printed re-stamp after review
 *      makes the next run clear.
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

/** The command on the one printed remedy line that contains `marker`. */
function printedCommand(section: string, marker: string): string {
  const lines = section.split("\n").filter((l) => l.includes("curl -su ") && l.includes(marker));
  expect(lines.length, `one printed command line containing ${marker}:\n${section}`).toBe(1);
  return lines[0].slice(lines[0].indexOf("curl -su "));
}

/** Run a printed command, with this instance's admin password wherever curl would prompt for it. */
function runPrinted(command: string): string {
  const user = harper.admin.username;
  expect(command.startsWith(`curl -su ${user} `)).toBe(true);
  for (const step of command.split(" && ")) expect(step).toContain(` ${harper.opsURL.replace(/\/?$/, "/")} `);
  const res = spawnSync("bash", ["-c", command.replaceAll(`curl -su ${user} `, `curl -su ${user}:${harper.admin.password} `)], { encoding: "utf-8", timeout: 20_000 });
  expect(res.status, `printed command failed: ${res.stderr}`).toBe(0);
  return res.stdout;
}

/** The ids the printed review command returns. */
function reviewedIds(section: string): string[] {
  const rows = JSON.parse(runPrinted(printedCommand(section, "review the rows")));
  expect(Array.isArray(rows), JSON.stringify(rows)).toBe(true);
  return rows.map((r: any) => String(r.id)).sort();
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

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
    // The printed review returns that row and no other; the printed re-stamp clears it.
    expect(reviewedIds(unattributedSection)).toEqual([copied]);
    expect(occurrences(runPrinted(printedCommand(unattributedSection, '"createdAt":')), "updated 1 of 1")).toBe(2);
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
    expect(reviewedIds(listedSection)).toEqual([written]);
    // The printed revoke clears it: a revoked row maps nobody and is not checked.
    expect(runPrinted(printedCommand(listedSection, '"status":"revoked"'))).toContain("updated 1 of 1");
    const revoked = await runDoctor();
    expect(idpSection(revoked.stdout)).toContain(CLEAR);
    expect(idpSection(revoked.stdout)).toContain("(3 active of 4 stored)");
    expect(issueCount(revoked.stdout), "the revoked row still moved the summary").toBe(baseCount);
    expect(revoked.code).toBe(base.code);

    // 4. An administrator creates a mapping, a write as the non-admin agent
    //    user changes its subject, and an administrator then edits its label.
    //    The label edit is an ordinary update: it leaves createdAt as it was, so
    //    it does not start the row's history over, and the subject change
    //    stays listed. The row is created with a whole-second createdAt, the
    //    form a review re-stamp writes, so only the unchanged createdAt tells
    //    the label edit from a re-stamp.
    const edited = `cred-idp-cli-edited-${sfx}`;
    const wholeSecondNow = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await asAdmin({ operation: "insert", table: "Credential", records: [{ id: edited, principalId: PRINCIPALS[2], kind: "idp", idpProvider: "mcp-oauth", idpSubject: `sub-edited-${sfx}`, status: "active", createdAt: wholeSecondNow }] });
    await opsAs("flair-agent", agentPass, { operation: "update", table: "Credential", records: [{ id: edited, idpSubject: `sub-edited-moved-${sfx}` }] });
    await asAdmin({ operation: "update", table: "Credential", records: [{ id: edited, label: "reviewed label" }] });
    const editedRun = await runDoctor();
    const editedSection = idpSection(editedRun.stdout);
    expect(editedSection).toContain(
      `1 IdP mapping row(s) written by a non-admin agent (from the audit log): ${edited} (principal '${PRINCIPALS[2]}', provider 'mcp-oauth')`,
    );
    expect(editedSection).not.toContain(CLEAR);
    expect(issueCount(editedRun.stdout), "the label edit cleared the non-admin subject change").toBe(baseCount + 1);
    expect(editedRun.code).toBe(1);
    // After review, the printed re-stamp (two updates of createdAt) starts the row's history over.
    expect(reviewedIds(editedSection)).toEqual([edited]);
    expect(occurrences(runPrinted(printedCommand(editedSection, '"createdAt":')), "updated 1 of 1")).toBe(2);
    const reviewed = await runDoctor();
    expect(idpSection(reviewed.stdout)).toContain(CLEAR);
    expect(idpSection(reviewed.stdout)).toContain("(4 active of 5 stored)");
    expect(issueCount(reviewed.stdout), "the re-stamped row still moved the summary").toBe(baseCount);
    expect(reviewed.code).toBe(base.code);
  }, 240_000);
});
