/**
 * #3082 item 3: `flair init --agent-id` refuses an id that is the operator
 * identity BEFORE it creates a key or registers an Agent. The skill seed
 * refuses the same id, but init registers the agent first, so before this
 * preflight the refusal landed after both writes.
 *
 * Each case runs the real CLI against an in-memory ops/HTTP API that records
 * every request, so "no Agent insert" is the recorded API traffic, not an
 * inference from the exit code.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

function runInit(home: string, args: string[], extraEnv: Record<string, string> = {}, cwd = home) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1" }, extraEnv);
  const script = `
    const { appendFileSync } = await import("node:fs");
    const log = ${JSON.stringify(join(home, "requests.jsonl"))};
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init) => {
      appendFileSync(log, JSON.stringify({ url: String(input), method: init?.method ?? "GET", body: init?.body ?? null }) + "\\n");
      if (String(input).endsWith("/FederationPair")) return new Response("instanceId and publicKey required", { status: 400 });
      if (init && typeof init.body === "string" && init.body.startsWith("{")) {
        const body = JSON.parse(init.body);
        if (body.operation === "sql") return json([]);
        return json({});
      }
      return json({ ok: true });
    };
    const { program } = await import(${JSON.stringify(CLI)});
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd,
    env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise init-operator-agent-id-3082 process fixture arguments" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return result;
}

/** Every request the in-memory API recorded; empty when none was made. */
function recordedRequests(home: string): Array<{ url: string; method: string; body: unknown }> {
  const path = join(home, "requests.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function expectRefused(home: string, result: ReturnType<typeof runInit>, id: string) {
  const out = result.stdout + result.stderr;
  expect(result.status, out).not.toBe(0);
  expect(out).toContain(`"${id}" is the operator identity`);
  expect(out).toContain("Choose another --agent-id");
  // No key file, and no request of any kind reached the instance.
  expect(existsSync(join(home, "keys"))).toBe(false);
  expect(recordedRequests(home)).toEqual([]);
}

describe("flair init --agent-id refuses the operator identity before the agent key or Agent write (flair#3082)", () => {
  test("remote init: the default operator id is refused", () => {
    const home = tempDir("opi-remote-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "admin",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "admin");
  });

  test("remote init: --admin-user names the operator for an already-running instance", () => {
    const home = tempDir("opi-remote-user-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--admin-user", "operator-b", "--agent-id", "operator-b",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "operator-b");
  });

  test("remote init: FLAIR_ADMIN_USER names the operator when no flag is given", () => {
    const home = tempDir("opi-remote-env-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "operator-c",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FLAIR_ADMIN_USER: "operator-c" });
    expectRefused(home, result, "operator-c");
  });

  test("remote provisioning: the provisioned default operator id wins over FLAIR_ADMIN_USER and is refused", () => {
    const home = tempDir("opi-remote-provision-");
    // The provisioning leg packs this root, so it must hold every entry the
    // deploy tarball lists.
    const root = join(home, "root");
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "schemas"), { recursive: true });
    for (const name of ["config.yaml", "package.json", "LICENSE", "README.md", "SECURITY.md"]) {
      writeFileSync(join(root, name), "");
    }
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--cluster-admin-user", "cluster-admin", "--cluster-admin-pass", "fixture-cluster-pass",
      "--agent-id", "admin",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FLAIR_ADMIN_USER: "operator-z" }, root);
    const out = result.stdout + result.stderr;
    expect(result.status, out).not.toBe(0);
    expect(out).toContain('"admin" is the operator identity');
    expect(out).toContain("Choose another --agent-id");
    // Provisioning wrote a secret and deployed before this preflight; what it
    // must not have done is create the agent key or insert the Agent row.
    expect(existsSync(join(home, "keys"))).toBe(false);
    const requests = recordedRequests(home);
    const bodies = requests.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : null)).filter(Boolean);
    expect(bodies.some((b: any) => b.operation === "deploy_component")).toBe(true);
    expect(bodies.some((b: any) => b.table === "Agent")).toBe(false);
  }, 120_000);

  test("local init: the default operator id is refused", () => {
    const home = tempDir("opi-local-");
    const result = runInit(home, [
      "init", "--agent-id", "admin", "--data-dir", join(home, "data"), "--keys-dir", join(home, "keys"),
      "--skip-start", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "admin");
  });

  test("local init: a different id is not refused by this preflight", () => {
    const home = tempDir("opi-local-other-");
    const result = runInit(home, [
      "init", "--agent-id", "agent-a", "--data-dir", join(home, "data"), "--keys-dir", join(home, "keys"),
      "--skip-start", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("is the operator identity");
  }, 60_000);
});
