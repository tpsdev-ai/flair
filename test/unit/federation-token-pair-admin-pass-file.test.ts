/**
 * `flair federation token` / `flair federation pair` accept `--admin-pass-file`
 * (flair#1873): the hub admin password is read in-process from an owner-only
 * file, so it need not sit in argv (shell history + the process list) or the
 * environment. The file is read through the SAME reader `flair backup` uses
 * (`readAdminPassFileSecure`), so a group- or world-readable file is refused
 * with a message naming the path and the mode.
 *
 * Precedence, as the usage text states: an explicit `--admin-pass-file` or
 * `--admin-pass` overrides `FLAIR_ADMIN_PASS`; giving both the file and the flag
 * is a usage error. Each test drives the real CLI against a stand-in hub/ops server
 * that records the Basic credential it was sent, so "authenticates" means the
 * credential actually left the process, not that a branch was taken.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

/** Distinctive values so a leak into stdout/stderr is unmistakable. */
const FILE_PASS = "file-secret-federation-1873";
const INLINE_PASS = "inline-secret-federation-1873";
const ENV_PASS = "env-secret-federation-1873";
const OPS_BASED = () => `http://127.0.0.1:${server.port}`;
const basic = (pass: string) => `Basic ${Buffer.from(`admin:${pass}`).toString("base64")}`;

interface Recorded {
  method: string;
  path: string;
  auth: string;
  operation?: string;
}

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Recorded[];

beforeEach(() => {
  dir = join(tmpdir(), `flair-fed-passfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: any;
      if (req.method === "POST") body = await req.json().catch(() => undefined);
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization") ?? "",
        operation: body?.operation,
      });
      if (url.pathname === "/FederationInstance") {
        return Response.json({ id: "spoke_test_1873", role: "spoke", publicKey: "spoke-pubkey-1873" });
      }
      if (url.pathname === "/FederationPair") {
        return Response.json({ instance: { id: "hub_test_1873", publicKey: "hub-pubkey-1873" } });
      }
      switch (body?.operation) {
        case "user_info":
          return Response.json({ role: { permission: { super_user: true } } });
        case "search_by_value":
          // Standing in for the legacy on-row key seed so pair can sign.
          return Response.json([{ _keySeed: randomBytes(32).toString("base64url") }]);
        default:
          return Response.json({ ok: true });
      }
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** The ops requests (path "/") that carried an admin Basic credential. */
function opsAuths(): string[] {
  return requests.filter((r) => r.path === "/" && r.operation !== undefined).map((r) => r.auth);
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

function tripleFile(): string {
  const file = join(dir, "triple.json");
  writeFileSync(
    file,
    JSON.stringify({
      token: "pairtoken1873abc",
      user: "pair-bootstrap-pairtok",
      password: "bootstrap-secret-1873",
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    }),
  );
  return file;
}

describe("federation token — --admin-pass-file (flair#1873)", () => {
  const tokenArgs = (extra: string[]) => ["federation", "token", "--ops-target", OPS_BASED(), ...extra];

  test("reads the password from an owner-only --admin-pass-file", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs(["--admin-pass-file", passFile(0o600)]));
    expect(stderr).not.toContain(FILE_PASS);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).token).toBeString();
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(FILE_PASS));
  });

  test("a 0644 file is refused naming the mode, and nothing is sent", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs(["--admin-pass-file", passFile(0o644)]));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("644");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stdout).not.toContain(FILE_PASS);
    expect(requests).toEqual([]);
  });

  test("file + --admin-pass together is a usage error, and nothing is sent", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      tokenArgs(["--admin-pass-file", passFile(0o600), "--admin-pass", INLINE_PASS]),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot be combined");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stderr).not.toContain(INLINE_PASS);
    expect(stdout).not.toContain(INLINE_PASS);
    expect(requests).toEqual([]);
  });

  test("--admin-pass still authenticates", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs(["--admin-pass", INLINE_PASS]));
    expect(stderr).not.toContain(INLINE_PASS);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).token).toBeString();
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(INLINE_PASS));
  });

  test("an explicit --admin-pass overrides FLAIR_ADMIN_PASS (explicit beats ambient)", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs(["--admin-pass", INLINE_PASS]), {
      FLAIR_ADMIN_PASS: ENV_PASS,
    });
    expect(stderr).not.toContain(INLINE_PASS);
    expect(stderr).not.toContain(ENV_PASS);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).token).toBeString();
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(INLINE_PASS));
  });

  test("--admin-pass-file overrides FLAIR_ADMIN_PASS", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs(["--admin-pass-file", passFile(0o600)]), {
      FLAIR_ADMIN_PASS: ENV_PASS,
    });
    expect(stderr).not.toContain(FILE_PASS);
    expect(stderr).not.toContain(ENV_PASS);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).token).toBeString();
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(FILE_PASS));
  });

  test("FLAIR_ADMIN_PASS alone still authenticates", async () => {
    const { stdout, stderr, exitCode } = await runCli(tokenArgs([]), { FLAIR_ADMIN_PASS: ENV_PASS });
    expect(stderr).not.toContain(ENV_PASS);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).token).toBeString();
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(ENV_PASS));
  });

  test("--help prefers the file form and warns that --admin-pass leaks", async () => {
    const { stdout, exitCode } = await runCli(["federation", "token", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--admin-pass-file");
    expect(stdout).toContain("shell history");
  });
});

describe("federation pair — --admin-pass-file (flair#1873)", () => {
  const pairArgs = (extra: string[]) => [
    "federation",
    "pair",
    OPS_BASED(),
    "--target",
    OPS_BASED(),
    "--ops-target",
    OPS_BASED(),
    "--token-from",
    tripleFile(),
    ...extra,
  ];

  test("reads the password from an owner-only --admin-pass-file and pairs", async () => {
    const { stdout, stderr, exitCode } = await runCli(pairArgs(["--admin-pass-file", passFile(0o600)]));
    expect(stderr).not.toContain(FILE_PASS);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Paired with hub");
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(FILE_PASS));
  });

  test("a 0644 file is refused naming the mode, and nothing is sent to the hub", async () => {
    const { stdout, stderr, exitCode } = await runCli(pairArgs(["--admin-pass-file", passFile(0o644)]));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("644");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stdout).not.toContain(FILE_PASS);
    expect(requests).toEqual([]);
  });

  test("file + --admin-pass together is a usage error, and nothing is sent", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      pairArgs(["--admin-pass-file", passFile(0o600), "--admin-pass", INLINE_PASS]),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot be combined");
    expect(stderr).not.toContain(FILE_PASS);
    expect(stderr).not.toContain(INLINE_PASS);
    expect(stdout).not.toContain(INLINE_PASS);
    expect(requests).toEqual([]);
  });

  test("--admin-pass still authenticates", async () => {
    const { stdout, stderr, exitCode } = await runCli(pairArgs(["--admin-pass", INLINE_PASS]));
    expect(stderr).not.toContain(INLINE_PASS);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Paired with hub");
    const auths = opsAuths();
    expect(auths.length).toBeGreaterThan(0);
    for (const auth of auths) expect(auth).toBe(basic(INLINE_PASS));
  });

  test("--help prefers the file form and warns that --admin-pass leaks", async () => {
    const { stdout, exitCode } = await runCli(["federation", "pair", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--admin-pass-file");
    expect(stdout).toContain("shell history");
  });
});