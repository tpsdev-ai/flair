/**
 * bridges-e2e-npm-plugin.test.ts — flair#2308.
 *
 * Bridge plugins are loaded from an npm package and driven end to end by the
 * real CLI. A fixture package with real entry-point files (its package.json
 * entry plus an index) is installed into a temp app's node_modules through a
 * local `file:` dependency — no registry — and then `flair bridge allow`,
 * `flair bridge import` and `flair bridge export` run through the built
 * dist/cli.js against it. The fixture's import/export handlers record the
 * `opts` object they receive, so the test pins the option record each path
 * builds:
 *
 *   - `flair bridge import` passes a null-prototype record (the plugin cannot
 *     reach `Object.prototype`), own option keys only;
 *   - `flair bridge export` passes a plain object (prototype present);
 *   - `Object.hasOwn` reports the passed option key on both.
 *
 * The loader is the production one: the test injects no `importer`, so a stub
 * that never imports the fixture produces no record and fails here.
 *
 * HOME is a scratch dir and every CLI spawn is HOME-isolated, so nothing
 * touches a real ~/.flair.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const CHILD_DEADLINE_MS = 20_000;
const INSTALL_DEADLINE_MS = 60_000;

const FIXTURE_NAME = "npmfixture";
const FIXTURE_PKG = `flair-bridge-${FIXTURE_NAME}`;
const FLAIR_URL = "http://127.0.0.1:1"; // dummy: the fixture never fetches Flair.

/**
 * The fixture's index. It records, as one JSON line per invocation, what the
 * production CLI handed its handler: the prototype state, whether inherited
 * members are reachable, the own keys, and what Object.hasOwn reports.
 */
const FIXTURE_INDEX = `import { appendFileSync } from "node:fs";

function record(op, opts) {
  const proto = Object.getPrototypeOf(opts);
  const line = JSON.stringify({
    op,
    protoIsNull: proto === null,
    protoIsObjectPrototype: proto === Object.prototype,
    hasOwnPropertyType: typeof opts.hasOwnProperty,
    toStringIn: "toString" in opts,
    ownKeys: Object.keys(opts).sort(),
    ownsUser: Object.hasOwn(opts, "user"),
    ownsAgent: Object.hasOwn(opts, "agent"),
    ownsToString: Object.hasOwn(opts, "toString"),
    user: typeof opts.user === "string" ? opts.user : null,
    agent: typeof opts.agent === "string" ? opts.agent : null,
  });
  const path = process.env.FLAIR_BRIDGE_FIXTURE_RECORD;
  if (path) appendFileSync(path, line + "\\n");
}

export const bridge = {
  name: "npmfixture",
  version: 1,
  kind: "api",
  async *import(opts) { record("import", opts); },
  async export(_memories, opts) { record("export", opts); },
};
`;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, FLAIR_AGENT_ID: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000, // literal so the spawn-budget gate sees a deadline (flair#1807)
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
              status: code,
              signal,
              elapsedMs: Date.now() - startedAt,
              stdout,
              stderr,
            }),
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** Install the fixture into the app's node_modules through a local `file:` dep. */
function installFixture(appDir: string): void {
  const res = spawnSync("bun", ["install", "--no-summary"], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (res.error) throw new Error(`fixture install could not run: ${res.error.message}`);
  if (res.signal === "SIGKILL") throw new Error(`fixture install exceeded ${INSTALL_DEADLINE_MS} ms — SIGKILLed`);
  if (res.status !== 0) throw new Error(`fixture install exited ${res.status}: ${res.stderr}`);
}

/** The record lines the fixture wrote, in order. No stat/lstat before the read. */
function recordLines(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("flair bridge: npm-loaded plugin option record (#2308)", () => {
  let scratch: string;
  let work: string;
  let app: string;

  beforeAll(() => {
    ensureCliBuild();

    scratch = mkdtempSync(join(tmpdir(), "flair-bridge-2308-home-"));
    work = mkdtempSync(join(tmpdir(), "flair-bridge-2308-work-"));
    app = join(work, "app");
    const pkg = join(work, "pkg");
    mkdirSync(app, { recursive: true });
    mkdirSync(pkg, { recursive: true });

    // Real entry-point files: package.json names the flair-bridge package and
    // points at the index the loader will import.
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify(
        { name: FIXTURE_PKG, version: "1.0.0", main: "index.mjs", type: "module", flair: { kind: "api" } },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(pkg, "index.mjs"), FIXTURE_INDEX);

    // The app installs it as a local dependency — no registry involved.
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        { name: "fixture-app", version: "1.0.0", private: true, dependencies: { [FIXTURE_PKG]: "file:../pkg" } },
        null,
        2,
      ) + "\n",
    );
    installFixture(app);
  }, 120_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("flair bridge import hands the plugin a null-prototype record of own option keys", async () => {
    // Approve the installed package, then import through it.
    const allowed = await runCli(["bridge", "allow", FIXTURE_NAME], { HOME: scratch }, app);
    expect(allowed.code).toBe(0);

    const recordPath = join(work, "import-record.jsonl");
    const res = await runCli(
      [
        "bridge", "import", FIXTURE_NAME,
        "--user", "user-a",
        "--agent", "agent-a",
        "--url", FLAIR_URL,
        "--dry-run",
      ],
      { HOME: scratch, FLAIR_BRIDGE_FIXTURE_RECORD: recordPath },
      app,
    );
    expect(res.code).toBe(0);

    const recs = recordLines(recordPath).filter((r) => r.op === "import");
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    // The production option copy is a null-prototype record: no Object.prototype.
    expect(rec.protoIsNull).toBe(true);
    expect(rec.protoIsObjectPrototype).toBe(false);
    // No inherited members: the record carries own option keys only.
    expect(rec.hasOwnPropertyType).toBe("undefined");
    expect(rec.toStringIn).toBe(false);
    expect(rec.ownKeys).toContain("user");
    expect(rec.ownKeys).not.toContain("toString");
    // Object.hasOwn still reports the option the CLI passed — and owns only.
    expect(rec.ownsUser).toBe(true);
    expect(rec.ownsToString).toBe(false);
    expect(rec.user).toBe("user-a");
  }, 25_000);

  it("flair bridge export hands the plugin a plain record where Object.hasOwn reports the option", async () => {
    const recordPath = join(work, "export-record.jsonl");
    const res = await runCli(
      [
        "bridge", "export", FIXTURE_NAME, "unused-dst",
        "--agent", "agent-a",
        "--url", FLAIR_URL,
      ],
      { HOME: scratch, FLAIR_BRIDGE_FIXTURE_RECORD: recordPath },
      app,
    );
    expect(res.code).toBe(0);

    const recs = recordLines(recordPath).filter((r) => r.op === "export");
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    // The export option copy is a plain object: a prototype is present.
    expect(rec.protoIsNull).toBe(false);
    expect(rec.protoIsObjectPrototype).toBe(true);
    expect(rec.hasOwnPropertyType).toBe("function");
    // Object.hasOwn reports the option the CLI passed — own keys only.
    expect(rec.ownsAgent).toBe(true);
    expect(rec.ownsToString).toBe(false);
    expect(rec.agent).toBe("agent-a");
  }, 25_000);
});
