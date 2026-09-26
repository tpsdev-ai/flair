/**
 * Round-2 regression witness for #1910.
 *
 * The shared `applyAdminPassFile` wrapper folds an explicit `--admin-pass-file`
 * (or `--admin-pass`) into `opts.adminPass`; each call site keeps its own
 * `opts.adminPass ?? FLAIR_ADMIN_PASS` fallback — main's shape. An earlier
 * revision of this change had the wrapper ALSO resolve the ambient
 * `FLAIR_ADMIN_PASS` into `opts.adminPass`. A site that threads `opts.adminPass`
 * as `explicitAdminPass` (memory add, soul) then sent ambient admin Basic auth
 * where it used to send nothing and let the `--agent` tier sign the write —
 * `memory add --agent X` with `FLAIR_ADMIN_PASS` set wrote as admin, not as X.
 * That is what emptied the mixed-version federation compat lane (federation sync
 * merged nothing), so it needs a witness in the unit lane, not only compat.
 *
 * This drives the real CLI: `memory add --agent <id>` with FLAIR_ADMIN_PASS in
 * the env and NO --admin-pass must send the flag-pinned agent's Ed25519
 * signature, not Basic admin.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const AGENT = "envtier-agent-1910";
const ENV_PASS = "env-admin-pass-1910-round2";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: { method: string; path: string; auth: string }[];

beforeEach(() => {
  dir = join(tmpdir(), `flair-envtier-1910-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".flair", "keys"), { recursive: true });
  // A registered 32-byte agent seed so the flag-pinned tier can sign.
  writeFileSync(join(dir, ".flair", "keys", `${AGENT}.key`), randomBytes(32));
  requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") ?? "" });
      return Response.json({ ok: true });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of ["FLAIR_AGENT_ID", "FLAIR_TARGET", "FLAIR_OPS_TARGET", "FLAIR_TOKEN", "FLAIR_ADMIN_USER", "FLAIR_KEY_DIR", "HDB_ADMIN_PASSWORD"]) {
    delete env[key];
  }
  env.HOME = dir;
  env.FLAIR_URL = `http://127.0.0.1:${server.port}`;
  env.FLAIR_ADMIN_PASS = ENV_PASS;
  const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("admin-pass wrapper must not pre-empt the flag-pinned agent tier (#1910 round 2)", () => {
  test("memory add --agent X with FLAIR_ADMIN_PASS set signs as X (TPS-Ed25519), not Basic admin", async () => {
    const { exitCode } = await runCli(["memory", "add", "env-tier witness", "--agent", AGENT]);
    expect(exitCode).toBe(0);
    const put = requests.find((r) => r.method === "PUT" && r.path.startsWith("/Memory/"));
    expect(put).toBeDefined();
    // The ambient FLAIR_ADMIN_PASS must NOT become an explicit admin credential
    // here: with an explicit --agent and no --admin-pass, the flag-pinned agent
    // signs the write.
    expect(put!.auth.startsWith(`TPS-Ed25519 ${AGENT}:`)).toBe(true);
    expect(put!.auth.startsWith("Basic ")).toBe(false);
  });
});
