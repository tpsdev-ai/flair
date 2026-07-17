/**
 * doctor-fleet-presence.test.ts — Integration tests for `flair doctor`'s
 * "Fleet presence" section (flair#639): known instances via /Presence
 * heartbeats, version stamping, and org-relative staleness.
 *
 * Drives the REAL built CLI (dist/cli.js) as subprocesses against a
 * throwaway Harper, same pattern as onboarding-smoke.test.ts:
 *   - startHarper() spins Harper from a mkdtemp install dir on OS-assigned
 *     free ports — NEVER ~/.flair, NEVER port 9926.
 *   - The CLI subprocesses run with HOME pointed at a separate mktemp dir,
 *     so the CLI's own ~/.flair (keys, config, admin-pass) is fully
 *     isolated too — never reads the host's real ~/.flair files.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass
const AGENT_A = "fleet-doctor-agent-a";
const LEGACY_STALE_ID = "fleet-doctor-agent-old";

let harper: HarperInstance;
let cliHome: string; // isolated HOME for the CLI's own ~/.flair

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const opsPort = new URL(harper.opsURL).port;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: cliHome,
        FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: opsPort,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`)); }, 30_000);
  });
}

beforeAll(async () => {
  harper = await startHarper();
  cliHome = await mkdtemp(join(tmpdir(), "flair-fleet-doctor-home-"));
}, 120_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
});

const httpPort = () => new URL(harper.httpURL).port;
const opsPort = () => new URL(harper.opsURL).port;

// The exact package.json this repo's resolveVersion() (resources/Presence.ts)
// reads at runtime — Harper is spawned with cwd: process.cwd() (this
// worktree root), so this is the SAME file the running server resolves.
const REAL_FLAIR_VERSION: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf-8"),
).version;

describe("flair doctor — fleet presence (flair#639, real CLI + real spawned Harper)", () => {
  test("agent add + presence heartbeat + doctor renders fleet presence with the real version", async () => {
    const add = await runCli([
      "agent", "add", AGENT_A,
      "--admin-pass", ADMIN_PASS,
      "--port", httpPort(),
      "--ops-port", opsPort(),
    ]);
    if (add.code !== 0) console.error(`agent add failed:\n${add.stdout}\n${add.stderr}`);
    expect(add.code).toBe(0);

    const set = await runCli([
      "presence", "set",
      "--agent", AGENT_A,
      "--activity", "coding",
      "--task", "flair#639 doctor integration test",
      "--port", httpPort(),
    ]);
    if (set.code !== 0) console.error(`presence set failed:\n${set.stdout}\n${set.stderr}`);
    expect(set.code).toBe(0);

    const doctor = await runCli(["doctor", "--port", httpPort(), "--agent", AGENT_A]);
    const out = `${doctor.stdout}${doctor.stderr}`;
    expect(out).toContain("Fleet presence");
    expect(out).toContain(AGENT_A);
    // The real bundled package.json version shows up unmodified — proves
    // resolveVersion()'s "keep in sync" copy resolves correctly against the
    // ACTUAL running package, not a stub.
    expect(out).toContain(`v${REAL_FLAIR_VERSION}`);
    // A single, freshly-heartbeated instance has nothing to compare
    // against — never flagged stale.
    expect(out).not.toContain("stale");
    // We passed --agent with a real key → versions must NOT be hidden.
    expect(out).not.toContain("hidden");
  }, 40_000);

  test("doctor without --agent: auto-iterates the local key (flair#722) — versions are NOT hidden", async () => {
    // cliHome already has AGENT_A's key on disk from the "agent add" call
    // above — flair#722's whole point is that doctor no longer needs --agent
    // to use it. This replaces the pre-#722 "hidden"/"Pass --agent" contract
    // this same scenario used to assert (that gate is now the ZERO-keys
    // fallback, covered by the fresh-HOME test below).
    const doctor = await runCli(["doctor", "--port", httpPort()]);
    const out = `${doctor.stdout}${doctor.stderr}`;
    expect(out).toContain("Fleet presence");
    expect(out).toContain(`Agent: ${AGENT_A}`);
    expect(out).toContain(AGENT_A);
    expect(out).toContain(`v${REAL_FLAIR_VERSION}`);
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("Pass --agent");
  }, 40_000);

  test("doctor without --agent, zero local keys: fleet identities still show, but versions are hidden (verified-reader gate)", async () => {
    // A totally separate, empty HOME (no `agent add` ever ran here) —
    // exercises the flair#722 zero-keys fallback: planAgentIterations()
    // returns an empty list, so doctor falls back to exactly the pre-#722
    // single unauthenticated read.
    const emptyHome = await mkdtemp(join(tmpdir(), "flair-fleet-doctor-empty-home-"));
    try {
      const doctor = await runCli(["doctor", "--port", httpPort()], { HOME: emptyHome });
      const out = `${doctor.stdout}${doctor.stderr}`;
      expect(out).toContain("Fleet presence");
      // Roster identity (agentId) is public regardless of the gate.
      expect(out).toContain(AGENT_A);
      expect(out).toContain("hidden");
      expect(out).toContain("Pass --agent");
      expect(out).not.toContain("Agent: ");
    } finally {
      await rm(emptyHome, { recursive: true, force: true, maxRetries: 4 });
    }
  }, 40_000);

  test("failure isolation (flair#722): an unregistered local key reports its own finding without hiding the registered agent's subsection", async () => {
    // Plant a second, bogus key directly in cliHome/.flair/keys — same shape
    // `agent add` writes (raw 32-byte Ed25519 seed), but never registered on
    // the server via the ops API. Both AGENT_A and this bogus id are now
    // enumerated by planAgentIterations(); the bogus one must render its own
    // "not registered" finding and the loop must still reach AGENT_A's
    // subsection afterward — that's the failure-isolation contract.
    const BOGUS_ID = "fleet-doctor-agent-unregistered";
    const keysDir = join(cliHome, ".flair", "keys");
    await mkdir(keysDir, { recursive: true });
    const kp = nacl.sign.keyPair();
    await writeFile(join(keysDir, `${BOGUS_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });

    try {
      const doctor = await runCli(["doctor", "--port", httpPort()]);
      const out = `${doctor.stdout}${doctor.stderr}`;
      expect(out).toContain(`Agent: ${BOGUS_ID}`);
      expect(out).toContain("NOT registered");
      expect(out).toContain(`flair agent add ${BOGUS_ID}`);
      // AGENT_A's own subsection must still render, unaffected.
      expect(out).toContain(`Agent: ${AGENT_A}`);
      expect(out).toContain(`v${REAL_FLAIR_VERSION}`);
    } finally {
      await unlink(join(keysDir, `${BOGUS_ID}.key`)).catch(() => {});
    }
  }, 40_000);

  test("an older-version instance is flagged stale and sorted ahead of the current one", async () => {
    // Seed a second, artificially OLD presence row directly via the ops API
    // (bypassing POST /Presence, which always stamps the CURRENT running
    // version by design — there's no way to make a live heartbeat report an
    // old version other than actually running an old build).
    const auth = "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64");
    const seedRes = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{
          agentId: LEGACY_STALE_ID,
          lastHeartbeatAt: Date.now(),
          activity: "idle",
          flairVersion: "0.0.1",
          harperVersion: "0.0.1",
        }],
      }),
    });
    expect(seedRes.ok).toBe(true);

    const doctor = await runCli(["doctor", "--port", httpPort(), "--agent", AGENT_A]);
    const out = `${doctor.stdout}${doctor.stderr}`;
    expect(out).toContain(LEGACY_STALE_ID);
    expect(out).toContain("stale");
    expect(out).toContain(`fleet newest is v${REAL_FLAIR_VERSION}`);

    // Sort oldest-version-first: the 0.0.1 row's line precedes the current
    // (real-version) agent's line within the Fleet presence section. Skip
    // past the "Agent: <id>" subsection header (flair#722) first — AGENT_A's
    // id appears there too, before the roster rows it introduces.
    const sectionStart = out.indexOf("Fleet presence");
    const rosterStart = out.indexOf(`Agent: ${AGENT_A}`, sectionStart) + `Agent: ${AGENT_A}`.length;
    const oldIdx = out.indexOf(LEGACY_STALE_ID, rosterStart);
    const currentIdx = out.indexOf(AGENT_A, rosterStart);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeLessThan(currentIdx);
  }, 40_000);

  test("natural-presence: a stale-activity instance renders 'offline' with its last-known activity, not a live label", async () => {
    // Seed a row with a CURRENT version (not version-stale) but a long-stale
    // heartbeat + activity stamp, so the only signal is activity decay — the
    // fleet section must read it as offline + last-known, same staleness
    // principle as the version column.
    const STALE_ACT_ID = "fleet-doctor-agent-stale-activity";
    const staleAt = Date.now() - 13 * 24 * 60 * 60 * 1000;
    const auth = "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64");
    const seedRes = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{
          agentId: STALE_ACT_ID,
          lastHeartbeatAt: staleAt,
          activityUpdatedAt: staleAt,
          activity: "debugging",
          currentTask: "on-call investigation complete",
          flairVersion: REAL_FLAIR_VERSION,
          harperVersion: "5.1.17",
        }],
      }),
    });
    expect(seedRes.ok).toBe(true);

    const doctor = await runCli(["doctor", "--port", httpPort(), "--agent", AGENT_A]);
    const out = `${doctor.stdout}${doctor.stderr}`;
    const sectionStart = out.indexOf("Fleet presence");
    const line = out.slice(sectionStart).split("\n").find((l) => l.includes(STALE_ACT_ID)) ?? "";
    expect(line).toContain("offline");
    // Last-known activity is shown as "(was: debugging)", never a live label.
    expect(line).toContain("was: debugging");
  }, 40_000);
});
