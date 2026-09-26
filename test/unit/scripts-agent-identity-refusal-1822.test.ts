/**
 * flair#1822 — every signing/mutating script refuses without an explicit agent
 * identity, BEFORE any key is read or any request is sent.
 *
 * Each script is driven as a real subprocess with a clean env and a
 * deliberately MISSING key path: the refusal must name both remedies, exit
 * non-zero, and never mention the key path (proving the key file was not
 * reached). A positive control runs one script WITH `--agent` to show the key
 * load IS reached once an identity is given — so "the key path is absent from
 * stderr" is a real observation, not a script that never reads keys.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const REMEDY = "FLAIR_AGENT_ID or pass --agent";

let tmp: string;
let missingKey: string;

beforeEach(() => {
  tmp = join(tmpdir(), `flair-1822-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  missingKey = join(tmp, "MISSING-KEY-do-not-read");
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface RunResult { code: number; out: string }

async function runScript(script: string, args: string[], extra: Record<string, string> = {}): Promise<RunResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Clean env: no identity, no inherited key override; HOME and FLAIR_PRIV_KEY
  // point at a scratch tree with NO key file.
  delete env.FLAIR_AGENT_ID;
  delete env.HARPER_WATCHDOG_AGENT_ID;
  delete env.FLAIR_KEY_DIR;
  env.HOME = tmp;
  env.FLAIR_PRIV_KEY = missingKey;
  env.FLAIR_MEMORY_DIR = join(tmp, "memory");
  Object.assign(env, extra);
  const proc = Bun.spawn([process.execPath, join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

const REFUSERS: Array<[string, string[]]> = [
  ["flair-bootstrap.mjs", []],
  ["flair-sync.mjs", []],
  ["flair-sync-soul.mjs", []],
  ["migrate-memories.mjs", [join(tmpdir(), "some-memory-dir")]],
  ["flair-activity.mjs", []],
];

describe("scripts refuse without an agent identity, before reading a key (flair#1822)", () => {
  for (const [script, args] of REFUSERS) {
    test(`${script}: exits non-zero naming both remedies, and never touches the key path`, async () => {
      const r = await runScript(script, args);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(REMEDY);
      expect(r.out).toContain("--agent");
      // The key file must NOT have been read: its path never appears.
      expect(r.out).not.toContain(missingKey);
    }, 30_000);
  }

  test("flair-client.mjs refuses a READ without an identity (reads sign too)", async () => {
    const r = await runScript("flair-client.mjs", ["memory", "list"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(REMEDY);
    expect(r.out).not.toContain(missingKey);
  }, 30_000);

  test("positive control: with --agent the key load IS reached (key path named)", async () => {
    // Same clean env, same missing key, but an explicit identity — so the script
    // gets PAST the identity guard and fails at the key load, naming the path.
    const r = await runScript("flair-bootstrap.mjs", ["--agent", "someone"]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("no agent identity");
    expect(r.out).toContain(missingKey);
  }, 30_000);
});
