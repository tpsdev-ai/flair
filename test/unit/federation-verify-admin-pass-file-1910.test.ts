/**
 * `flair federation verify` resolves the admin password through the ONE
 * resolver (`resolveAdminPassFromSources`), the same one `federation
 * token`/`pair` use (flair#1909/#1910). Before this it used the older
 * `applyAdminPassFile`, which let `--admin-pass` silently win over
 * `--admin-pass-file` and then fell back to `opts.adminPass ?? env`.
 *
 * Each test drives the real CLI against a stand-in server that records the
 * Basic credential it was sent.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

const FILE_PASS = "file-secret-federation-1910-verify";
const INLINE_PASS = "inline-secret-federation-1910-verify";
const basic = (pass: string) => `Basic ${Buffer.from(`admin:${pass}`).toString("base64")}`;

interface Recorded {
  method: string;
  path: string;
  auth: string;
}

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Recorded[];

beforeEach(() => {
  dir = join(tmpdir(), `flair-fed-verify-1910-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization") ?? "",
      });
      if (url.pathname === "/FederationPeers") {
        // No peers to probe: verify's sync push finds no hub, then lists an
        // empty peer set and returns without waiting.
        return Response.json({ peers: [] });
      }
      return Response.json({ ok: true });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** Every request that actually carried an Authorization header. */
function auths(): string[] {
  return requests.filter((r) => r.auth).map((r) => r.auth);
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of [
    "FLAIR_ADMIN_PASS",
    "HDB_ADMIN_PASSWORD",
    "FLAIR_URL",
    "FLAIR_TARGET",
    "FLAIR_OPS_TARGET",
    "FLAIR_AGENT_ID",
    "FLAIR_TOKEN",
    "FLAIR_ADMIN_USER",
  ]) {
    delete env[key];
  }
  env.HOME = dir;
  Object.assign(env, extraEnv);
  const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

function passFile(mode: number, value: string = FILE_PASS): string {
  const file = join(dir, `admin-pass-${mode.toString(8)}`);
  writeFileSync(file, `${value}\n`, "utf-8");
  chmodSync(file, mode);
  return file;
}

describe("federation verify — --admin-pass-file (flair#1910)", () => {
  const verifyArgs = (extra: string[]) => [
    "federation",
    "verify",
    "--target",
    `http://127.0.0.1:${server.port}`,
    "--ops-target",
    `http://127.0.0.1:${server.port}`,
    "--agent",
    "verify-agent-1910",
    "--wait",
    "1",
    ...extra,
  ];

  test("reads the password from an owner-only --admin-pass-file", async () => {
    const { stderr, exitCode } = await runCli(verifyArgs(["--admin-pass-file", passFile(0o600)]));
    expect(stderr).not.toContain(FILE_PASS);
    expect(exitCode).toBe(0);
    const seen = auths();
    expect(seen.length).toBeGreaterThan(0);
    for (const auth of seen) expect(auth).toBe(basic(FILE_PASS));
  });

  test("a 0644 file is refused naming the mode, and nothing is sent", async () => {
    const { stdout, stderr, exitCode } = await runCli(verifyArgs(["--admin-pass-file", passFile(0o644)]));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("644");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stdout).not.toContain(FILE_PASS);
    expect(requests).toEqual([]);
  });

  test("file + --admin-pass together is a usage error, and nothing is sent", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      verifyArgs(["--admin-pass-file", passFile(0o600), "--admin-pass", INLINE_PASS]),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot be combined");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stderr).not.toContain(INLINE_PASS);
    expect(stdout).not.toContain(INLINE_PASS);
    expect(requests).toEqual([]);
  });

  test("--admin-pass still authenticates", async () => {
    const { stderr, exitCode } = await runCli(verifyArgs(["--admin-pass", INLINE_PASS]));
    expect(stderr).not.toContain(INLINE_PASS);
    expect(exitCode).toBe(0);
    const seen = auths();
    expect(seen.length).toBeGreaterThan(0);
    for (const auth of seen) expect(auth).toBe(basic(INLINE_PASS));
  });

  test("--help prefers the file form and warns that --admin-pass leaks", async () => {
    const { stdout, exitCode } = await runCli(["federation", "verify", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--admin-pass-file");
    expect(stdout).toContain("shell history");
  });
});
