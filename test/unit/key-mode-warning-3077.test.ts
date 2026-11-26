/**
 * key-mode-warning-3077.test.ts — flair#3077 slice D.
 *
 * `flair doctor` and `flair status` warn when an agent key file is wider than
 * owner-only: the path, its octal mode and the exact remedy `chmod 600 <path>`.
 * A group bit alone (0640) is enough. A symlinked key is reported as not
 * checked and its target is not read for a mode. Neither command changes a
 * key file's bytes or mode.
 *
 * Each case runs the real CLI from source on a throwaway HOME; status talks to
 * an in-process mock of /Health and /HealthDetail so no instance is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
// The child's own deadline and the per-case budget above it are written inline
// as literals because the spawn-budget gate reads the call text, not a constant.
const POSIX_ONLY = process.platform === "win32";

let scratch: string;
let server: Server;
let url = "";

function makeHome(name: string): string {
  const home = join(scratch, name);
  mkdirSync(join(home, ".flair", "keys"), { recursive: true });
  return home;
}

function writeKey(home: string, id: string, mode: number): string {
  const path = join(home, ".flair", "keys", `${id}.key`);
  writeFileSync(path, `seed-${id}-3077`);
  chmodSync(path, mode);
  return path;
}

/** Async on purpose: the mock instance answers on this process's event loop. */
function runCli(args: string[], home: string): Promise<{ output: string; status: number | null }> {
  const startedAt = Date.now();
  const child = spawn("bun", [CLI, ...args], {
    env: { HOME: home, PATH: process.env.PATH ?? "", TERM: "dumb", TMPDIR: tmpdir() },
    timeout: 30_000,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (status, signal) => {
      const elapsedMs = Date.now() - startedAt;
      if (status === null && elapsedMs >= 30_000) {
        reject(new Error(childOverranDeadline("flair CLI", args.join(" "), 30_000, {
          status,
          signal,
          stdout,
          stderr,
          elapsedMs,
          timeoutSignal: "SIGTERM",
        })));
        return;
      }
      resolve({ output: `${stdout}${stderr}`, status });
    });
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "flair-3077-key-mode-"));
  server = createServer((req, res) => {
    if (req.url === "/Health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.0.0" }));
      return;
    }
    if (req.url === "/HealthDetail") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.0", pid: 1, uptimeSeconds: 1, warnings: [] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe("agent key file modes are reported by doctor and status", () => {
  test.skipIf(POSIX_ONLY)("doctor warns on 0644 and 0640, stays silent on 0600, and does not follow a symlink", async () => {
    const home = makeHome("doctor");
    const wide = writeKey(home, "agent-a", 0o644);
    const group = writeKey(home, "agent-c", 0o640);
    const narrow = writeKey(home, "agent-b", 0o600);
    const link = join(home, ".flair", "keys", "agent-link.key");
    symlinkSync(narrow, link);

    const { output } = await runCli(["doctor"], home);

    expect(output).toContain(`agent key file ${wide} has mode 0644`);
    expect(output).toContain(`chmod 600 ${wide}`);
    expect(output).toContain(`agent key file ${group} has mode 0640`);
    expect(output).toContain(`chmod 600 ${group}`);
    expect(output).toContain(`agent key file ${link} not checked (symbolic link)`);
    expect(output).not.toContain(`agent key file ${narrow}`);

    expect(readFileSync(wide, "utf8")).toBe("seed-agent-a-3077");
    expect(readFileSync(narrow, "utf8")).toBe("seed-agent-b-3077");
    expect(readlinkSync(link)).toBe(narrow);
    expect(statSync(wide).mode & 0o777).toBe(0o644);
    expect(statSync(narrow).mode & 0o777).toBe(0o600);
  }, 60_000);

  test.skipIf(POSIX_ONLY)("status prints the same warnings one line each and leaves the files alone", async () => {
    const home = makeHome("status");
    const wide = writeKey(home, "agent-a", 0o644);
    const group = writeKey(home, "agent-c", 0o640);
    const narrow = writeKey(home, "agent-b", 0o600);
    const link = join(home, ".flair", "keys", "agent-link.key");
    symlinkSync(narrow, link);

    const { output, status } = await runCli(["status", "--url", url], home);

    expect(status).toBe(0);
    expect(output).toContain(`agent key file ${wide} has mode 0644`);
    expect(output).toContain(`chmod 600 ${wide}`);
    expect(output).toContain(`agent key file ${group} has mode 0640`);
    expect(output).toContain(`chmod 600 ${group}`);
    expect(output).toContain(`agent key file ${link} not checked (symbolic link)`);
    expect(output).not.toContain(`agent key file ${narrow}`);

    expect(readFileSync(wide, "utf8")).toBe("seed-agent-a-3077");
    expect(readFileSync(narrow, "utf8")).toBe("seed-agent-b-3077");
    expect(statSync(wide).mode & 0o777).toBe(0o644);
    expect(statSync(narrow).mode & 0o777).toBe(0o600);
  }, 60_000);

  test.skipIf(POSIX_ONLY)("doctor says nothing about a 0600 key", async () => {
    const home = makeHome("doctor-0600");
    writeKey(home, "agent-a", 0o600);

    const { output } = await runCli(["doctor"], home);

    expect(output).not.toContain("agent key file");
  }, 60_000);

  test.skipIf(POSIX_ONLY)("status says nothing about a 0600 key", async () => {
    const home = makeHome("status-0600");
    writeKey(home, "agent-a", 0o600);

    const { output, status } = await runCli(["status", "--url", url], home);

    expect(status).toBe(0);
    expect(output).not.toContain("agent key file");
  }, 60_000);
});
