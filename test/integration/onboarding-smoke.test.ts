/**
 * onboarding-smoke.test.ts — first-run onboarding smoke test.
 *
 * Regression guard for the three first-run CLI bugs reported by an external
 * dogfooder (HarperDB engineer kriszyp):
 *   #499 — agent seeding must use the Harper operations API, not a REST-root
 *          ops-insert (which 405s as a collection POST to /Agent).
 *   #498 — `flair soul set` must PUT /Soul/{agentId:key}, not POST /Soul
 *          (which 405s — the Soul table resource has no POST handler).
 *   #500 — `flair agent list --admin-pass` must not null-scan the primary key
 *          ("id is not indexed for nulls" 400 on bundled Harper 5.0.21).
 *
 * Drives the REAL built CLI (dist/cli.js) as subprocesses against a throwaway
 * Harper:
 *   - startHarper() spins Harper from a mkdtemp install dir on OS-assigned free
 *     ports — NEVER ~/.flair, NEVER port 9926.
 *   - The CLI subprocesses run with HOME pointed at a separate mktemp dir, so
 *     the CLI's own ~/.flair (keys, config, admin-pass) is fully isolated too.
 *   - stopHarper() kills the process and removes the temp install dir; the
 *     CLI HOME temp dir is removed in afterAll.
 *
 * End-to-end flow exercised: agent add (#499 seed path) → soul set (#498)
 * → agent list (#500).
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js must exist
 * (`bun run build && bun run build:cli`).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "krais-onboarding";
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass

let harper: HarperInstance;
let cliHome: string; // isolated HOME for the CLI's own ~/.flair

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Run the built CLI as a subprocess, pointed at the throwaway Harper instance.
// HOME is an isolated temp dir, FLAIR_URL + FLAIR_OPS_PORT target the alt ports,
// so nothing reads or writes the developer's real ~/.flair or port 9926.
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const opsPort = new URL(harper.opsURL).port;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: cliHome, // isolates ~/.flair (keys, config, admin-pass)
        FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: opsPort,
        // Defensive: ensure no inherited token/admin identity leaks in. The
        // agent identity comes from the on-disk key written by `agent add`
        // (under cliHome/.flair/keys), resolved via FLAIR_AGENT_ID per-command.
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
  cliHome = await mkdtemp(join(tmpdir(), "flair-onboarding-home-"));
}, 120_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
});

describe("first-run onboarding (real CLI, isolated temp Harper + home)", () => {
  // #499: agent seeding goes through the ops API. `flair agent add` uses the
  // exact seedAgentViaOpsApi(opsPort, ...) call the `flair init` agent path now
  // uses, so a green add proves the seed mechanism the init path depends on.
  test("agent add seeds via ops API (#499)", async () => {
    // No --keys-dir: write the key to the default ~/.flair/keys (under the
    // isolated cliHome), so later Ed25519-authed commands resolve it.
    const r = await runCli([
      "agent", "add", AGENT_ID,
      "--admin-pass", ADMIN_PASS,
      "--port", new URL(harper.httpURL).port,
      "--ops-port", new URL(harper.opsURL).port,
    ]);
    if (r.code !== 0) console.error(`agent add failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("registered");
    // The old bug surfaced as a REST 405; assert that error never appears.
    expect(`${r.stdout}${r.stderr}`).not.toContain("405");
    expect(`${r.stdout}${r.stderr}`).not.toContain("does not have a post method");
  });

  // #498: soul set must PUT /Soul/{id}, not POST the collection.
  test("soul set succeeds via PUT /Soul/{id} (#498)", async () => {
    // soul set talks to the REST API via api(), which resolves the target from
    // FLAIR_URL (set by runCli). It has no --port/--ops-port flags.
    const r = await runCli([
      "soul", "set",
      "--agent", AGENT_ID,
      "--key", "role",
      "--value", "onboarding smoke",
    ], { FLAIR_AGENT_ID: AGENT_ID });
    if (r.code !== 0) console.error(`soul set failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.code).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain("405");
    expect(`${r.stdout}${r.stderr}`).not.toContain("does not have a post method");

    // Confirm the record actually landed: read it back via the server.
    const id = `${AGENT_ID}:role`;
    const res = await fetch(`${harper.httpURL}/Soul/${encodeURIComponent(id)}`, {
      headers: { Authorization: "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64") },
    });
    expect(res.ok).toBe(true);
    const soul = await res.json() as { id?: string; value?: string };
    expect(soul.id).toBe(id);
    expect(soul.value).toBe("onboarding smoke");
  });

  // #500: agent list with --admin-pass must not null-scan the PK.
  test("agent list does not null-scan the PK (#500)", async () => {
    // agent list resolves the ops port from FLAIR_OPS_PORT (set by runCli);
    // it exposes --port but not --ops-port.
    const r = await runCli([
      "agent", "list",
      "--admin-pass", ADMIN_PASS,
      "--port", new URL(harper.httpURL).port,
      "--json",
    ]);
    if (r.code !== 0) console.error(`agent list failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.code).toBe(0);
    // The old bug surfaced as a 400 "id is not indexed for nulls".
    expect(`${r.stdout}${r.stderr}`).not.toContain("not indexed for nulls");
    expect(`${r.stdout}${r.stderr}`).not.toContain("400");
    const agents = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.some(a => a.id === AGENT_ID)).toBe(true);
  });
});
