/**
 * cli-port-config-1719.test.ts — `flair <command>` must honour the `port:`
 * the operator wrote in `~/.flair/config.yaml` (flair#1719).
 *
 * The reported shape: the per-user config says `port: 9926` and a daemon is
 * serving 9926, but `flair status` resolved — and reported — 19926, then told
 * the user to "edit ~/.flair/config.yaml to set port: 9926", which it already
 * said. The resolver was reading Harper's own boot record
 * (`<dataDir>/harper-config.yaml`), which can be stale relative to the file
 * the operator actually edits.
 *
 * These drive the real `status` command as a subprocess (isolated $HOME + a
 * local HTTP mock). HOME has to be real: `os.homedir()` does not re-read an
 * in-process env mutation.
 *
 * On current main this test FAILS: status resolves 19926 from the stale
 * Harper record and prints `URL:  http://127.0.0.1:19926` (unreachable). With
 * the fix it PASSES: the recorded port is dead, the configured port has the
 * daemon, and status resolves and reports `http://127.0.0.1:<configured>`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";

/** The stale port Harper's boot record carries — the wrong answer on main. */
const STALE_RECORDED_PORT = 19926;

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startMockFlairServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/Health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.54.2", buildCommit: null, searchReady: true }));
        return;
      }
      if (req.url === "/HealthDetail") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ warnings: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function installedVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"));
  return String(pkg.version);
}

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const CLEAR_ENV = {
  FLAIR_ADMIN_PASS: undefined,
  HDB_ADMIN_PASSWORD: undefined,
  FLAIR_AGENT_ID: undefined,
  FLAIR_TOKEN: undefined,
  FLAIR_URL: undefined,
  FLAIR_TARGET: undefined,
};

describe("flair#1719 — the resolved URL honours ~/.flair/config.yaml's port", () => {
  let tmpHome: string;
  let server: Server;
  let configuredPort: number;

  beforeEach(async () => {
    tmpHome = makeTmpDir("flair1719-home");
    const started = await startMockFlairServer();
    server = started.server;
    configuredPort = started.port;

    mkdirSync(join(tmpHome, ".flair", "data"), { recursive: true });
    mkdirSync(join(tmpHome, ".flair", "keys"), { recursive: true });

    // The operator's file, exactly as the issue shows it: the daemon's port.
    writeFileSync(
      join(tmpHome, ".flair", "config.yaml"),
      `# Flair configuration\nport: ${configuredPort}\nopsPort: ${configuredPort - 1}\nopsBind: 127.0.0.1\n`,
    );

    // Harper's own boot record, stale: it still names the previous default.
    // This is the value the resolver was reading instead of the config above.
    writeFileSync(
      join(tmpHome, ".flair", "data", "harper-config.yaml"),
      ["http:", `  port: ${STALE_RECORDED_PORT}`, "operationsApi:", "  network:", `    port: "127.0.0.1:${configuredPort - 1}"`, ""].join("\n"),
    );

    // Pin the version cache so status does not hit the npm registry.
    writeFileSync(
      join(tmpHome, ".flair", ".version-check-cache.json"),
      JSON.stringify({ latest: installedVersion(), checkedAt: Date.now() }),
    );
  });

  afterEach(async () => {
    await stopServer(server);
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  test("status resolves and reports the configured port, not the stale recorded one", async () => {
    const { stdout } = await runCli(["status"], { HOME: tmpHome, ...CLEAR_ENV });

    // The resolved URL is the one the config and the running daemon agree on.
    expect(stdout).toContain(`http://127.0.0.1:${configuredPort}`);
    expect(stdout).not.toContain(`http://127.0.0.1:${STALE_RECORDED_PORT}`);
    // And it is genuinely healthy, not merely discovered after the fact.
    expect(stdout).toContain("running");
  }, 30_000);
});

/**
 * The per-user file is read as YAML, not regex-matched. Each of these is a
 * valid config the old `/port:\s*(\d+)/` matched wrongly or not at all, so
 * the CLI silently fell through to 19926 while the file said 9926.
 */
describe("flair#1719 — readPortFromConfig reads what the operator wrote", () => {
  async function readPort(contents: string): Promise<string> {
    const home = makeTmpDir("flair1719-read");
    mkdirSync(join(home, ".flair"), { recursive: true });
    writeFileSync(join(home, ".flair", "config.yaml"), contents);
    const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
    const script = `import { readPortFromConfig } from ${JSON.stringify(cliPath)}; console.log(String(readPortFromConfig()));`;
    try {
      const proc = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, HOME: home, FLAIR_URL: "", FLAIR_TARGET: "" },
        stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error(`port reader exit ${proc.exitCode}: ${err}`);
      return out.trim();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("quoted value", async () => {
    expect(await readPort('port: "9926"\n')).toBe("9926");
  }, 30_000);

  test("a commented-out prior port does not shadow the live one", async () => {
    expect(await readPort("# Flair configuration\n# port: 19926\nport: 9926\n")).toBe("9926");
  }, 30_000);

  test("whitespace before the colon", async () => {
    expect(await readPort("port : 9926\n")).toBe("9926");
  }, 30_000);
});
