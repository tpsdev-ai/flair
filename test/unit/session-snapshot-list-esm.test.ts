/**
 * session-snapshot-list-esm.test.ts — dist-level regression guard for
 * flair#1653.
 *
 * `flair session snapshot list` crashed in the shipped ESM build
 * (dist/cli.js): src/commands/session.ts carried a runtime
 * `require("node:fs")` in the same compiled module as `await`, so Node's ESM
 * loader refused the file with ERR_AMBIGUOUS_MODULE_SYNTAX ("both require()
 * and top-level await are present"). Because that branch only runs when
 * ~/.flair/snapshots/ already exists, the source-level unit suite and the
 * CLI-surface snapshot never executed it — CI stayed green on a broken
 * shipped binary.
 *
 * This drives the REAL built CLI through `node` (the runtime users run, NOT
 * the bun process executing the test suite — bun tolerates `require` in ESM,
 * so testing under it would not fire) with a snapshots tree present, so the
 * previously-dead branch executes against compiled dist/ output.
 *
 * It builds dist/cli.js itself (mirroring test/unit/presence-set.test.ts) so
 * a stale or absent build fails the test rather than passing it vacuously.
 */
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], home: string): RunResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      // Isolate ~/.flair entirely: the command under test resolves every
      // snapshot path under HOME, and nothing here may touch the real one.
      HOME: home,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let home: string | undefined;

// Build dist/cli.js AT MOST ONCE per lane (flair#1807): this hook used to race
// the same `bun run build:cli` in sibling files' beforeAll (all concurrent
// writers of dist/, all racing bun's 5 s hook default). ensureCliBuild() skips
// the build when dist/cli.js is already newer than src/, and serializes
// concurrent callers on a "wx" lock so exactly one build runs. The 120 s budget
// names a genuine build hang instead of letting the 5 s default kill it bare.
beforeAll(() => {
  ensureCliBuild();
}, 120_000);

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

/** Create $HOME/.flair/snapshots/<agent>/sessions/<file>.tar.gz fixtures. */
function seedSnapshots(entries: Array<{ agent: string; file: string }>): void {
  home = mkdtempSync(join(tmpdir(), "flair-session-snapshot-esm-"));
  for (const { agent, file } of entries) {
    const dir = join(home!, ".flair", "snapshots", agent, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), "not-a-real-tarball\n");
  }
}

describe("flair session snapshot list — shipped ESM build (flair#1653)", () => {
  test("lists snapshots from an existing ~/.flair/snapshots without an ESM require crash", () => {
    seedSnapshots([
      { agent: "demo", file: "2099-01-01T00-00-00-000Z.tar.gz" },
      { agent: "other", file: "2099-02-02T00-00-00-000Z.tar.gz" },
    ]);

    const { status, stdout, stderr } = runCli(["session", "snapshot", "list"], home!);
    const combined = stdout + stderr;

    // The compiled module must not mix require() with top-level await.
    expect(combined).not.toMatch(/ERR_AMBIGUOUS_MODULE_SYNTAX/i);
    expect(combined).not.toMatch(/require is not defined/i);
    expect(combined).not.toMatch(/ReferenceError/i);
    expect(status, `exit=${status}\n${combined.slice(0, 500)}`).toBe(0);

    // Positive control: the listing branch genuinely ran (its output is
    // printed), not merely "did not crash".
    expect(stdout).toContain("2099-01-01T00-00-00-000Z.tar.gz");
    expect(stdout).toContain("2099-02-02T00-00-00-000Z.tar.gz");
    expect(stdout).toMatch(/2 snapshots\./);
  }, 45_000);

  test("--json lists the same snapshots", () => {
    seedSnapshots([{ agent: "demo", file: "2099-03-03T00-00-00-000Z.tar.gz" }]);

    const { status, stdout, stderr } = runCli(["session", "snapshot", "list", "--json"], home!);
    const combined = stdout + stderr;

    expect(combined).not.toMatch(/ERR_AMBIGUOUS_MODULE_SYNTAX/i);
    expect(status, `exit=${status}\n${combined.slice(0, 500)}`).toBe(0);

    const rows = JSON.parse(stdout) as Array<{ agent: string; file: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("demo");
    expect(rows[0].file).toBe("2099-03-03T00-00-00-000Z.tar.gz");
  }, 45_000);
});
