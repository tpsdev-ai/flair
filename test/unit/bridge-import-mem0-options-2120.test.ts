/**
 * bridge-import-mem0-options-2120.test.ts — flair#2120.
 *
 * `flair bridge import` declared neither `--user` nor `--api-key`, yet the mem0
 * bridge's hint told operators to pass both — `flair bridge import mem0 --user x`
 * exited 1 with `unknown option '--user'`. This proves, through the real built
 * CLI, that the forms the hint now names are the forms the command accepts:
 *
 *   - the user reaches the bridge via `--user <id>`;
 *   - the API key reaches the bridge via `MEM0_API_KEY` or `--api-key-file <path>`
 *     (group/world permissions refused; 0600 recommended), never as an argv value;
 *   - a missing user or key refuses with the remedy and a non-zero exit;
 *   - a group/world-readable key file is refused (named remedy), before any fetch;
 *   - the key is absent from output on these normal file and env paths.
 * Hostile response and pagination diagnostics are tested without a listener in
 * bridge-mem0-security-2188.test.ts.
 *
 * The mem0 API is a local mock (like test/unit/bridge-mem0.test.ts); the CLI runs
 * HOME-isolated to a scratch dir so nothing touches a real ~/.flair.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");

// A value that never appears in the bridge's own output; asserted absent below.
const SENTINEL_KEY = "mem0-sentinel-2f9c1a4e-token";

interface Observed {
  auth: string;
  userId: string | null;
}

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, FLAIR_AGENT_ID: "", MEM0_API_KEY: "", ...env },
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

describe("flair bridge import mem0: the hinted credential form is the accepted form (#2120)", () => {
  let scratch: string;
  let dir: string;
  let keyPath: string;
  let keyFile0644: string;
  let server: Server;
  let mockUrl: string;
  const observed: Observed[] = [];
  let requestCount = 0;

  beforeAll(async () => {
    ensureCliBuild();

    scratch = mkdtempSync(join(tmpdir(), "flair-bridge-2120-home-"));
    dir = mkdtempSync(join(tmpdir(), "flair-bridge-2120-work-"));

    keyPath = join(scratch, "mem0-key");
    writeFileSync(keyPath, SENTINEL_KEY + "\n");
    chmodSync(keyPath, 0o600);

    keyFile0644 = join(scratch, "mem0-key-open");
    writeFileSync(keyFile0644, SENTINEL_KEY + "\n");
    chmodSync(keyFile0644, 0o644);

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestCount += 1; // count EVERY inbound request, before routing
      const u = new URL(req.url ?? "/", "http://localhost");
      observed.push({
        auth: String(req.headers["authorization"] ?? ""),
        userId: u.searchParams.get("user_id"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "m1", memory: "hello from mem0" }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("mock server did not bind");
    mockUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  // The Flair target URL is a dummy: --dry-run never PUTs. It is passed so the
  // command doesn't resolve a Harper port from a real install.
  const FLAIR_URL = "http://127.0.0.1:1";

  it("the key reaches the bridge via --api-key-file (and never appears in output)", async () => {
    const before = observed.length;
    const res = await runCli(
      ["bridge", "import", "mem0", "--user", "u1", "--api-key-file", keyPath, "--base-url", mockUrl, "--agent", "a1", "--url", FLAIR_URL, "--dry-run"],
      { HOME: scratch },
      dir,
    );

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("would import");
    const seen = observed.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Token ${SENTINEL_KEY}`);
    expect(seen[0].userId).toBe("u1");
    expect(res.stdout).not.toContain(SENTINEL_KEY);
    expect(res.stderr).not.toContain(SENTINEL_KEY);
  }, 25_000);

  it("the key reaches the bridge via MEM0_API_KEY (and never appears in output)", async () => {
    const before = observed.length;
    const res = await runCli(
      ["bridge", "import", "mem0", "--user", "u2", "--base-url", mockUrl, "--agent", "a1", "--url", FLAIR_URL, "--dry-run"],
      { HOME: scratch, MEM0_API_KEY: SENTINEL_KEY },
      dir,
    );

    expect(res.code).toBe(0);
    const seen = observed.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Token ${SENTINEL_KEY}`);
    expect(seen[0].userId).toBe("u2");
    expect(res.stdout).not.toContain(SENTINEL_KEY);
    expect(res.stderr).not.toContain(SENTINEL_KEY);
  }, 25_000);

  it("a missing --user refuses with the remedy and a non-zero exit", async () => {
    const before = requestCount;
    const res = await runCli(
      ["bridge", "import", "mem0", "--api-key-file", keyPath, "--base-url", mockUrl, "--agent", "a1", "--url", FLAIR_URL, "--dry-run"],
      { HOME: scratch },
      dir,
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("--user");
    expect(requestCount).toBe(before); // the bridge refused before any fetch
  }, 25_000);

  it("a missing key refuses with the remedy and a non-zero exit", async () => {
    const before = requestCount;
    const res = await runCli(
      ["bridge", "import", "mem0", "--user", "u1", "--base-url", mockUrl, "--agent", "a1", "--url", FLAIR_URL, "--dry-run"],
      { HOME: scratch },
      dir,
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("--api-key-file");
    expect(res.stderr).toContain("MEM0_API_KEY");
    expect(requestCount).toBe(before); // the bridge refused before any fetch
  }, 25_000);

  it("a group/world-readable key file is refused with a named remedy, before any fetch", async () => {
    const before = requestCount;
    const res = await runCli(
      ["bridge", "import", "mem0", "--user", "u1", "--api-key-file", keyFile0644, "--base-url", mockUrl, "--agent", "a1", "--url", FLAIR_URL, "--dry-run"],
      { HOME: scratch },
      dir,
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("chmod 600");
    expect(res.stderr).toContain("644");
    expect(requestCount).toBe(before);
    expect(res.stderr).not.toContain(SENTINEL_KEY);
  }, 25_000);
});
