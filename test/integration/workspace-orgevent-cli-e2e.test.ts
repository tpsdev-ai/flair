/**
 * workspace-orgevent-cli-e2e.test.ts — real-Harper integration coverage for
 * `flair workspace set` and `flair orgevent` (flair#679).
 *
 * Bug (`flair workspace set`, CONFIRMED against a real spawned Harper below):
 * it sent a bare `POST /WorkspaceState` (collection-level, no id in the URL).
 * WorkspaceState.post() (resources/WorkspaceState.ts) delegates to
 * `super.post(content)` — the Harper-generated table class's OWN post()
 * implementation, which 405s a collection POST with "does not have a post
 * method implemented to handle HTTP method POST" (same restriction
 * resources/Memory.ts documents, already fixed the same way for `soul set`
 * #498 — see test/integration/onboarding-smoke.test.ts, which this file's
 * structure mirrors). Table writes over real HTTP require `PUT /<Table>/<id>`
 * with the id in the URL.
 *
 * CORRECTION to the issue's premise (measured, not assumed — see the "sanity"
 * tests below): `flair orgevent`'s bare `POST /OrgEvent` does NOT currently
 * 405. OrgEvent.post() (resources/OrgEvent.ts) does NOT delegate to
 * `super.post()` — it generates its own id/createdAt and calls
 * `databases.flair.OrgEvent.put(content)` directly, which Harper's REST layer
 * DOES route a real HTTP POST to. So today's shipped `flair orgevent` exits 0
 * and writes successfully. It is still switched to PUT/{id} here because (a)
 * that's what the issue and the fix instructions specify, (b) it makes
 * OrgEvent's write path consistent with every other table resource
 * (WorkspaceState, Memory, Soul) instead of relying on an accident of
 * OrgEvent.post()'s specific implementation — a future refactor that made
 * OrgEvent.post() delegate to super.post() (mirroring WorkspaceState.post())
 * would silently reintroduce this exact 405 with zero CLI-side change to
 * notice it, and (c) client-generated `${agentId}-${randomUUID()}` ids avoid
 * the same-millisecond collision risk of post()'s own
 * `${authorId}-${isoTimestamp}` default.
 *
 * The bug was INVISIBLE to the mock-HTTP-server unit suites
 * (test/unit/workspace-set.test.ts, test/unit/orgevent-cli.test.ts) — a mock
 * server accepts any method/path, so it could never catch a real Harper's
 * 405. Only a real spawned Harper closes that gap, which is what this file
 * does: drives the REAL built CLI (dist/cli.js) as subprocesses against a
 * throwaway Harper, then reads the written rows back over real HTTP to prove
 * the write didn't just "exit 0" — it actually landed and is readable.
 *
 * Build prerequisite: dist/cli.js (bun run build:cli).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const AGENT_ID = "flair679-e2e-agent";
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass

let harper: HarperInstance;
let cliHome: string; // isolated HOME for the CLI's own ~/.flair (keys, config)

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Run the built CLI as a subprocess, pointed at the throwaway Harper instance.
// HOME is an isolated temp dir, FLAIR_URL targets the alt port — nothing reads
// or writes the developer's real ~/.flair or port 9926. Mirrors
// onboarding-smoke.test.ts's runCli() exactly.
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

function adminAuthHeader(): string {
  return "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64");
}

beforeAll(async () => {
  harper = await startHarper();
  cliHome = await mkdtemp(join(tmpdir(), "flair679-e2e-home-"));

  // Seed the agent identity via the real CLI path (`agent add`, #499) —
  // writes the Ed25519 key under cliHome/.flair/keys and registers the Agent
  // record via the ops API, exactly like a real first-run.
  const add = await runCli([
    "agent", "add", AGENT_ID,
    "--admin-pass", ADMIN_PASS,
    "--port", new URL(harper.httpURL).port,
    "--ops-port", new URL(harper.opsURL).port,
  ]);
  if (add.code !== 0) throw new Error(`agent add failed:\n${add.stdout}\n${add.stderr}`);
}, 120_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair workspace set / flair orgevent — real Harper (#679)", () => {
  // Structural sanity check FIRST: confirms the 405 this issue is about is a
  // real, current property of a real spawned Harper (not a stale claim) —
  // same measurement test/integration/attention-query-e2e.test.ts already
  // made for its own fixture seeding.
  test("sanity: a bare POST /WorkspaceState collection write still 405s on this Harper", async () => {
    const res = await fetch(`${harper.httpURL}/WorkspaceState`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuthHeader() },
      body: JSON.stringify({ id: "should-never-write", agentId: "nobody", ref: "x", provider: "test", timestamp: new Date().toISOString(), createdAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(405);
    const text = await res.text();
    expect(text).toContain("does not have a post method");
  });

  test("workspace set writes via PUT /WorkspaceState/{id}, round-trips readable (#679)", async () => {
    const r = await runCli(
      ["workspace", "set", "--ref", "cp679-fix", "--phase", "implement", "--task", "679", "--summary", "fixing bare POST 405 for flair#679"],
      { FLAIR_AGENT_ID: AGENT_ID },
    );
    if (r.code !== 0) console.error(`workspace set failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Workspace state updated");
    // The old bug surfaced as a REST 405; assert that error never appears.
    expect(`${r.stdout}${r.stderr}`).not.toContain("405");
    expect(`${r.stdout}${r.stderr}`).not.toContain("does not have a post method");

    // MEASURED round-trip: read the record back over real HTTP (admin bypasses
    // WorkspaceState's owner-scoping — resources/WorkspaceState.ts's get()) to
    // prove the write actually landed, not just that the CLI exited 0.
    const id = `${AGENT_ID}:cp679-fix`;
    const res = await fetch(`${harper.httpURL}/WorkspaceState/${id}`, {
      headers: { Authorization: adminAuthHeader() },
    });
    expect(res.status).toBe(200);
    const ws = await res.json() as Record<string, unknown>;
    expect(ws.id).toBe(id);
    expect(ws.agentId).toBe(AGENT_ID);
    expect(ws.ref).toBe("cp679-fix");
    expect(ws.phase).toBe("implement");
    expect(ws.taskId).toBe("679");
    expect(ws.summary).toBe("fixing bare POST 405 for flair#679");
    expect(typeof ws.createdAt).toBe("string");
  });

  test("workspace set is idempotent per (agentId, ref) — a second call overwrites the same row", async () => {
    const r = await runCli(
      ["workspace", "set", "--ref", "cp679-fix", "--phase", "review", "--summary", "second write, same ref"],
      { FLAIR_AGENT_ID: AGENT_ID },
    );
    expect(r.code).toBe(0);

    const id = `${AGENT_ID}:cp679-fix`;
    const res = await fetch(`${harper.httpURL}/WorkspaceState/${id}`, {
      headers: { Authorization: adminAuthHeader() },
    });
    expect(res.status).toBe(200);
    const ws = await res.json() as Record<string, unknown>;
    expect(ws.phase).toBe("review");
    expect(ws.summary).toBe("second write, same ref");
  });

  // UNLIKE WorkspaceState, a bare POST /OrgEvent does NOT 405 today — measured
  // directly (this test), and confirmed by running the ORIGINAL (pre-fix)
  // `flair orgevent` CLI against a real spawned Harper: it exits 0 and writes
  // successfully. See the module doc's "CORRECTION to the issue's premise"
  // for why OrgEvent.post() (resources/OrgEvent.ts) doesn't hit the same gap
  // WorkspaceState.post() does, and why this CLI command is still switched to
  // PUT/{id} despite its current POST path already working.
  test("sanity: a bare POST /OrgEvent collection write does NOT 405 today (unlike WorkspaceState) — this is why orgevent still needs the PUT fix for FUTURE-proofing, not a currently-broken write", async () => {
    const res = await fetch(`${harper.httpURL}/OrgEvent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuthHeader() },
      body: JSON.stringify({ id: "probe-should-not-405", authorId: "nobody", kind: "status", summary: "x", createdAt: new Date().toISOString() }),
    });
    expect(res.status).not.toBe(405);
  });

  test("orgevent publishes via PUT /OrgEvent/{id}, round-trips readable (#679)", async () => {
    const r = await runCli(
      ["orgevent", "--kind", "status", "--summary", "flair#679 e2e verification", "--target", "flint"],
      { FLAIR_AGENT_ID: AGENT_ID },
    );
    if (r.code !== 0) console.error(`orgevent failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OrgEvent published");
    // The old bug surfaced as a REST 405; assert that error never appears.
    expect(`${r.stdout}${r.stderr}`).not.toContain("405");
    expect(`${r.stdout}${r.stderr}`).not.toContain("does not have a post method");

    // The CLI prints the generated id (`  id: <id>`) — extract it so the
    // round-trip read doesn't have to guess the randomUUID suffix.
    const idMatch = r.stdout.match(/id:\s*(\S+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];
    expect(id.startsWith(`${AGENT_ID}-`)).toBe(true);

    // MEASURED round-trip: read the record back over real HTTP (admin bypasses
    // OrgEvent's own-authorId check — resources/OrgEvent.ts) to prove the
    // write actually landed, not just that the CLI exited 0.
    const res = await fetch(`${harper.httpURL}/OrgEvent/${id}`, {
      headers: { Authorization: adminAuthHeader() },
    });
    expect(res.status).toBe(200);
    const ev = await res.json() as Record<string, unknown>;
    expect(ev.id).toBe(id);
    expect(ev.authorId).toBe(AGENT_ID);
    expect(ev.kind).toBe("status");
    expect(ev.summary).toBe("flair#679 e2e verification");
    expect(ev.targetIds).toEqual(["flint"]);
    expect(typeof ev.createdAt).toBe("string");
  });

  test("orgevent generates a fresh id per call — two publishes never collide", async () => {
    const r1 = await runCli(["orgevent", "--kind", "status", "--summary", "first"], { FLAIR_AGENT_ID: AGENT_ID });
    const r2 = await runCli(["orgevent", "--kind", "status", "--summary", "second"], { FLAIR_AGENT_ID: AGENT_ID });
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    const id1 = r1.stdout.match(/id:\s*(\S+)/)![1];
    const id2 = r2.stdout.match(/id:\s*(\S+)/)![1];
    expect(id1).not.toBe(id2);
  });
});
