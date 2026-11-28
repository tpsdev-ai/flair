/**
 * flair#3136 item 1: `flair bootstrap`, `flair attention`, `flair search`,
 * `flair bridge import` and `flair bridge export` refuse a non-empty id outside
 * the rule with the shared agent-ID message before a key read or request for
 * that record.
 * Each case runs the built CLI with an explicit `--key` against a local stub server
 * with a real Ed25519 key file; the child's preload records the
 * readFileSync/openSync path arguments.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ensureCliBuild, spawnCli } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { invalidAgentIdMessage } from "../../src/lib/agent-id-rule.js";

const PRELOAD = resolve(import.meta.dirname, "../../test/fixtures/key-path-read-log-preload.cjs");
const CHILD_DEADLINE_MS = 20_000;
const BAD_ID = "bad/id";

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  reads: string[];
}

function runCli(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const readLog = join(home, "reads.log");
  writeFileSync(readLog, "");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)),
  );
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    FLAIR_TEST_KEY_READ_LOG: readLog,
    ...extraEnv,
  });
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawnCli(args, {
      cwd: home,
      env,
      timeout: 20_000, // literal for the spawn-budget gate
      preload: PRELOAD,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, {
          status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr,
        })));
        return;
      }
      const reads = readFileSync(readLog, "utf8").trim().split("\n").filter(Boolean);
      resolvePromise({ stdout, stderr, code, reads });
    });
  });
}

let scratch: string;
let keyPath: string;
let server: Server;
let port: number;
let requests = 0;

beforeAll(async () => {
  ensureCliBuild();
  scratch = mkdtempSync(join(tmpdir(), "flair-key-path-explicit-3136-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  keyPath = join(scratch, "agent.key");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface CommandCase {
  name: string;
  args: (home: string, url: string) => string[];
}

const CASES: CommandCase[] = [
  { name: "flair bootstrap", args: (_home, url) => ["bootstrap", "--agent", BAD_ID, "--key", keyPath, "--url", url] },
  {
    name: "flair attention",
    args: (_home, url) => ["attention", "repo:owner/name", "--agent", BAD_ID, "--key", keyPath, "--url", url],
  },
  { name: "flair search", args: (_home, url) => ["search", "hello", "--agent", BAD_ID, "--key", keyPath, "--url", url] },
  {
    name: "flair bridge import",
    args: (_home, url) => ["bridge", "import", "markdown", "--agent", BAD_ID, "--key", keyPath, "--url", url],
  },
  {
    name: "flair bridge export",
    args: (home, url) => ["bridge", "export", "markdown", join(home, "out"), "--agent", BAD_ID, "--key", keyPath, "--url", url],
  },
];

const RECORD_BRIDGE = "record-id-bridge";

/** A project YAML bridge whose map reads the agent id from each record. */
function writeRecordBridge(home: string, records: string[]): void {
  mkdirSync(join(home, ".flair-bridge"), { recursive: true });
  writeFileSync(
    join(home, ".flair-bridge", `${RECORD_BRIDGE}.yaml`),
    [
      `name: ${RECORD_BRIDGE}`,
      "version: 1",
      "kind: file",
      "import:",
      "  sources:",
      "    - path: records.jsonl",
      "      format: jsonl",
      "      map:",
      '        content: "$.text"',
      '        id: "$.id"',
      '        agentId: "$.agent"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(home, "records.jsonl"), records.map((record) => `${record}\n`).join(""));
}

describe("flair#3136 — an invalid agent id with --key is refused before a key read or request for that record", () => {
  for (const command of CASES) {
    test(`${command.name} refuses ${JSON.stringify(BAD_ID)} with --key`, async () => {
      const home = join(scratch, `home-${command.name.replace(/[^a-z]+/gi, "-")}`);
      mkdirSync(home, { recursive: true });
      requests = 0;

      const { stdout, stderr, code, reads } = await runCli(
        command.args(home, `http://127.0.0.1:${port}`),
        home,
      );

      const out = stdout + stderr;
      expect(code, out).not.toBe(0);
      expect(out).toContain(invalidAgentIdMessage(BAD_ID));
      expect(reads).not.toContain(keyPath);
      expect(requests).toBe(0);
    }, 30_000);
  }

  test("flair bridge import refuses an invalid agent id carried by a record", async () => {
    const home = join(scratch, "home-bridge-record-id");
    mkdirSync(home, { recursive: true });
    writeRecordBridge(home, [JSON.stringify({ id: "rec-1", agent: BAD_ID, text: "hello there" })]);
    requests = 0;

    const { stdout, stderr, code, reads } = await runCli(
      ["bridge", "import", RECORD_BRIDGE, "--cwd", home, "--key", keyPath, "--url", `http://127.0.0.1:${port}`],
      home,
    );

    const out = stdout + stderr;
    expect(code, out).toBe(1);
    expect(out).toContain(invalidAgentIdMessage(BAD_ID));
    expect(reads).not.toContain(keyPath);
    expect(requests).toBe(0);
  }, 30_000);

  test("flair bridge import refuses an invalid FLAIR_AGENT_ID", async () => {
    const home = join(scratch, "home-bridge-env-id");
    mkdirSync(home, { recursive: true });
    // The record carries its own VALID agent id, so only the environment id
    // can be what refuses the run.
    writeRecordBridge(home, [JSON.stringify({ id: "rec-1", agent: "agent-a", text: "hello there" })]);
    requests = 0;

    const { stdout, stderr, code, reads } = await runCli(
      ["bridge", "import", RECORD_BRIDGE, "--cwd", home, "--key", keyPath, "--url", `http://127.0.0.1:${port}`],
      home,
      { FLAIR_AGENT_ID: BAD_ID },
    );

    const out = stdout + stderr;
    expect(code, out).toBe(1);
    expect(out).toContain(invalidAgentIdMessage(BAD_ID));
    expect(reads).not.toContain(keyPath);
    expect(requests).toBe(0);
  }, 30_000);
});

describe("the read/fetch preload records normalised path arguments", () => {
  test("Buffer and URL fs paths and Request/URL fetch inputs are recorded", async () => {
    const home = join(scratch, "preload-self-test");
    mkdirSync(home, { recursive: true });
    const target = join(home, "target.txt");
    writeFileSync(target, "x");
    const readLog = join(home, "reads.log");
    const fetchLog = join(home, "fetch.log");
    writeFileSync(readLog, "");
    writeFileSync(fetchLog, "");
    const script = join(home, "probe.mjs");
    writeFileSync(script, [
      'import { closeSync, openSync, readFileSync } from "node:fs";',
      "const target = process.argv[2];",
      "readFileSync(Buffer.from(target));",
      'readFileSync(new URL("file://" + target));',
      'const fd = openSync(Buffer.from(target), "r");',
      "closeSync(fd);",
      'await fetch(new Request("http://127.0.0.1:1/request-path"));',
      'await fetch(new URL("http://127.0.0.1:1/url-path"));',
    ].join("\n"));

    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)),
    );
    Object.assign(env, { HOME: home, USERPROFILE: home, FLAIR_TEST_KEY_READ_LOG: readLog, FLAIR_TEST_FETCH_LOG: fetchLog });
    const result = spawnSync(
      nodeBin({ env, cwd: home }),
      ["--import", pathToFileURL(PRELOAD).href, script, target],
      { env, cwd: home, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

    const reads = readFileSync(readLog, "utf8").trim().split("\n").filter(Boolean);
    expect(reads).toContain(target);
    expect(reads).toContain(`file://${target}`);
    const fetches = readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean);
    expect(fetches).toEqual(["/request-path", "/url-path"]);
  }, 30_000);
});
