/**
 * doctor-agent-id-rule-cli-2359.test.ts — flair#2359, against a REAL Harper.
 *
 * Drives the REAL built CLI (`dist/cli.js`) subprocesses, same pattern as
 * test/integration/doctor-fleet-presence.test.ts:
 *   - startHarper() spins Harper from a mkdtemp install dir on OS-assigned
 *     free ports — NEVER ~/.flair, NEVER port 9926.
 *   - The CLI subprocesses run with HOME pointed at a separate mktemp dir, so
 *     the CLI's own ~/.flair (keys, config, admin-pass) is fully isolated.
 *
 * `flair doctor`'s "Agent IDs" section reports stored Agent ids outside the
 * shared rule (flair#2359). This file proves two things the section must not
 * get wrong on a real instance:
 *   1. a stored id below the former `createdAt > "1970-01-01"` cutoff is
 *      reported, and the finding moves the summary count;
 *   2. an Agent-ID check that could NOT run — no admin credential, a failed
 *      roster read, or an admin-pass file the credential resolver refuses — is
 *      a counted issue, not a clean result.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass

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
function runDoctor(adminPass: string): Promise<RunResult> {
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
        FLAIR_ADMIN_PASS: adminPass,
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

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-2359-doctor-home-"));
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("flair doctor — the Agent IDs section (flair#2359, real CLI + real spawned Harper)", () => {
  test("reports a below-filter invalid id, and an unrun check is a counted issue", async () => {
    // 1. Baseline: readable roster, no invalid stored id.
    const base = await runDoctor(ADMIN_PASS);
    expect(base.stderr, base.stderr).toBe("");
    expect(base.stdout).toContain("No stored agent id is outside");
    const baseCount = issueCount(base.stdout);

    // 2. A stored id whose createdAt sorts BELOW "1970-01-01" — the old
    //    `createdAt > "1970-01-01"` filtered search would exclude it entirely.
    //    It carries a home so only the Agent-ID section moves: this case is
    //    about the id rule, not the home rule.
    const seeded = "outside.filter.bad"; // a dot is not in the rule
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: seeded, name: seeded, role: "agent", status: "active", publicKey: "seeded-public-key", createdAt: "1969-12-31T00:00:00.000Z", originatorInstanceId: "inst-fixture-2359" }],
    });

    const reported = await runDoctor(ADMIN_PASS);
    expect(reported.stdout, "the below-filter invalid id was not reported").toContain(seeded);
    expect(reported.stdout).toContain("outside the agent-ID rule");
    expect(issueCount(reported.stdout), "the reported invalid id did not move the summary").toBe(baseCount + 1);

    // 3. A roster read that fails (wrong admin credential) is a counted issue —
    //    for the Agent-ID section AND the Agent homes section (both read the
    //    same roster, so both are unrun).
    const unreadable = await runDoctor("wrong-admin-pass-not-a-secret");
    expect(unreadable.stdout).toContain("Could not read the stored Agent roster");
    expect(unreadable.stdout).not.toContain("No stored agent id is outside");
    expect(issueCount(unreadable.stdout), "the unrun check left the summary clean").toBe(baseCount + 2);

    // 4. No admin credential at all: the Agent-ID check is a counted issue, not
    //    a pass; the Agent homes check is reported skipped and not counted.
    const noCred = await runDoctor("");
    expect(noCred.stdout).toContain("no admin credentials");
    expect(noCred.stdout).toContain("Agent homes check skipped (no admin credential)");
    expect(issueCount(noCred.stdout), "the skipped check left the summary clean").toBe(baseCount + 1);
  }, 120_000);

  test("an unsafe or empty admin-pass file: doctor completes and counts the unrun check with the resolver's reason", async () => {
    // The reference: no admin credential at all, which the test above proves
    // is one counted issue (the Agent-ID check) over the clean baseline.
    const noCred = await runDoctor("");
    expect(noCred.stdout).toContain("no admin credentials");
    const unrunCount = issueCount(noCred.stdout);

    const flairDir = join(cliHome, ".flair");
    const passFile = join(flairDir, "admin-pass");
    await mkdir(flairDir, { recursive: true });
    const cases = [
      // The right password, in a file group/other can read: the resolver refuses it.
      { label: "group/other-readable", content: `${ADMIN_PASS}\n`, mode: 0o644, reason: "permissions 644 are too open" },
      { label: "empty", content: "", mode: 0o600, reason: "file is empty or contains only whitespace" },
    ];
    try {
      for (const c of cases) {
        await writeFile(passFile, c.content, "utf-8");
        await chmod(passFile, c.mode);
        // FLAIR_ADMIN_PASS empty, so the resolver falls through to the file.
        const r = await runDoctor("");
        expect(r.code, `${c.label}: doctor did not complete\n${r.stdout}\n${r.stderr}`).toBe(1);
        expect(r.stdout, `${c.label}: the unrun check was not reported`).toContain("the admin credential could not be resolved (");
        expect(r.stdout, `${c.label}: the resolver's reason was not reported`).toContain(c.reason);
        expect(r.stdout).toContain("so the agent-id check did not run");
        expect(r.stdout).not.toContain("No stored agent id is outside");
        expect(issueCount(r.stdout), `${c.label}: the unrun check was not counted`).toBe(unrunCount);
      }
    } finally {
      await rm(passFile, { force: true });
    }
  }, 120_000);
});
