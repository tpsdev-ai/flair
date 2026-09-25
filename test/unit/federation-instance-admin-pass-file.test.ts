/**
 * `flair federation instance list` / `prune` take the admin password the way
 * every other admin command does (flair#1883, Sherlock's review of #1894):
 * `--admin-pass-file` reads it in-process from an owner-only file, so the
 * secret for a destructive remote prune need not sit in argv or the env.
 *
 * Each test drives the real CLI against a stand-in ops API that records the
 * Basic credentials it was sent.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

describe("federation instance list/prune --admin-pass-file (flair#1883)", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let seenAuth: string[];

  beforeEach(() => {
    dir = join(tmpdir(), `flair-instance-passfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    seenAuth = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        return Response.json([
          { id: "flair_passfile_a", publicKey: "key-a", role: "hub", status: "active", createdAt: "2026-09-25T00:00:00.000Z" },
          { id: "flair_passfile_b", publicKey: "key-b", role: "spoke", status: "active", createdAt: "2026-09-25T00:00:01.000Z" },
        ]);
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.FLAIR_ADMIN_PASS;
    env.HOME = dir;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: await proc.exited };
  }

  const basic = (pass: string) => `Basic ${Buffer.from(`admin:${pass}`).toString("base64")}`;
  const opsTarget = () => `http://127.0.0.1:${server.port}`;

  function passFile(mode: number): string {
    const file = join(dir, `admin-pass-${mode.toString(8)}`);
    writeFileSync(file, "file-secret-1883\n", "utf-8");
    chmodSync(file, mode);
    return file;
  }

  test("list sends the password read from an owner-only --admin-pass-file", async () => {
    const { stdout, exitCode } = await runCli(
      ["federation", "instance", "list", "--ops-target", opsTarget(), "--admin-pass-file", passFile(0o600), "--json"],
    );
    expect(exitCode).toBe(0);
    expect(seenAuth).toEqual([basic("file-secret-1883")]);
    expect(JSON.parse(stdout).rows.map((r: any) => r.id)).toEqual(["flair_passfile_a", "flair_passfile_b"]);
  });

  test("prune (dry run) sends the password read from --admin-pass-file", async () => {
    const { exitCode } = await runCli(
      ["federation", "instance", "prune", "--keep", "flair_passfile_a", "--ops-target", opsTarget(), "--admin-pass-file", passFile(0o600)],
    );
    expect(exitCode).toBe(0);
    expect(seenAuth.length).toBeGreaterThan(0);
    for (const auth of seenAuth) expect(auth).toBe(basic("file-secret-1883"));
  });

  test("a group- or world-readable file is refused before anything is sent", async () => {
    for (const command of [["list"], ["prune", "--keep", "flair_passfile_a"]]) {
      seenAuth = [];
      const { stderr, exitCode } = await runCli(
        ["federation", "instance", ...command, "--ops-target", opsTarget(), "--admin-pass-file", passFile(0o644)],
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("chmod 600");
      expect(seenAuth).toEqual([]);
    }
  });

  test("an inline --admin-pass still wins over the file", async () => {
    const { exitCode } = await runCli(
      ["federation", "instance", "list", "--ops-target", opsTarget(), "--admin-pass", "inline-1883", "--admin-pass-file", passFile(0o600)],
    );
    expect(exitCode).toBe(0);
    expect(seenAuth).toEqual([basic("inline-1883")]);
  });
});
