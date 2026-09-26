/**
 * `flair backup` resolves the admin password through the ONE resolver
 * (`resolveAdminPassFromSources`), the same one `federation token`/`pair` use
 * (flair#1910). Before this it used the older `applyAdminPassFile`, which let
 * `--admin-pass` silently win over `--admin-pass-file`.
 *
 * The one test drives the real CLI against a stand-in server: file + flag is
 * now a usage error with nothing sent; the flag alone still authenticates.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

const FILE_PASS = "file-secret-backup-1910";
const INLINE_PASS = "inline-secret-backup-1910";
const basic = (pass: string) => `Basic ${Buffer.from(`admin:${pass}`).toString("base64")}`;

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; auth: string }[];

beforeEach(() => {
  dir = join(tmpdir(), `flair-backup-1910-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  requests = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, auth: req.headers.get("authorization") ?? "" });
      if (url.pathname === "/Agent/") return Response.json([]);
      return Response.json([]);
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of ["FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_URL", "FLAIR_TARGET", "FLAIR_AGENT_ID", "FLAIR_TOKEN", "FLAIR_ADMIN_USER"]) {
    delete env[key];
  }
  env.HOME = dir;
  const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

function passFile(mode: number): string {
  const file = join(dir, `admin-pass-${mode.toString(8)}`);
  writeFileSync(file, `${FILE_PASS}\n`, "utf-8");
  chmodSync(file, mode);
  return file;
}

describe("backup — file/flag conflict is a usage error (flair#1910)", () => {
  const backupArgs = (extra: string[]) => [
    "backup",
    "--url",
    `http://127.0.0.1:${server.port}`,
    "--output",
    join(dir, "out.json"),
    ...extra,
  ];

  test("file + --admin-pass is now a usage error (was: flag wins silently); the flag alone still works", async () => {
    const bad = await runCli(backupArgs(["--admin-pass-file", passFile(0o600), "--admin-pass", INLINE_PASS]));
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("cannot be combined");
    expect(bad.stderr).not.toContain(FILE_PASS);
    expect(bad.stderr).not.toContain(INLINE_PASS);
    expect(requests).toEqual([]);

    const ok = await runCli(backupArgs(["--admin-pass", INLINE_PASS]));
    expect(ok.exitCode).toBe(0);
    const agentReqs = requests.filter((r) => r.path === "/Agent/");
    expect(agentReqs.length).toBeGreaterThan(0);
    for (const r of agentReqs) expect(r.auth).toBe(basic(INLINE_PASS));
  });
});
