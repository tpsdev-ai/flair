/**
 * #3082 item 3: `flair init --agent-id` refuses an administrator username
 * reserved by this init path BEFORE it creates a key or registers an Agent. init
 * registers the agent before any later check, so without this preflight a
 * refusal would land after both writes.
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
        if (body.operation === "list_users") return json(JSON.parse(process.env.FIXTURE_LIST_USERS ?? "[]"));
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

function requestBodies(home: string): any[] {
  return recordedRequests(home).map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : null)).filter(Boolean);
}

function expectRefused(home: string, result: ReturnType<typeof runInit>, id: string) {
  const out = result.stdout + result.stderr;
  expect(result.status, out).not.toBe(0);
  expect(out).toContain(`"${id}" is an administrator username reserved by this init path`);
  expect(out).toContain("Choose another --agent-id");
  // No key file, and no request of any kind reached the instance.
  expect(existsSync(join(home, "keys"))).toBe(false);
  expect(recordedRequests(home)).toEqual([]);
}

/** A provisioning root holding every entry the deploy tarball lists. */
function deployRoot(home: string): string {
  const root = join(home, "root");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  for (const name of ["config.yaml", "package.json", "LICENSE", "README.md", "SECURITY.md"]) {
    writeFileSync(join(root, name), "");
  }
  return root;
}

describe("flair init --agent-id refuses a reserved administrator username before the agent key or Agent write (flair#3082)", () => {
  test("remote provisioning: the default administrator username is reserved and refused before provisionFabric", () => {
    const home = tempDir("opi-prov-admin-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--cluster-admin-user", "cluster-admin", "--cluster-admin-pass", "fixture-cluster-pass",
      "--agent-id", "admin",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FLAIR_ADMIN_USER: "operator-z", FIXTURE_LIST_USERS: JSON.stringify([
      { username: "cluster-admin", role: { permission: { super_user: false } } },
    ]) });
    expectRefused(home, result, "admin");
    // provisionFabric never ran: not even the deploy reached the instance.
    expect(requestBodies(home).some((b: any) => b.operation === "deploy_component")).toBe(false);
  });

  test("remote provisioning: the cluster administrator username is reserved and refused before provisionFabric", () => {
    const home = tempDir("opi-prov-cluster-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--cluster-admin-user", "cluster-admin", "--cluster-admin-pass", "fixture-cluster-pass",
      "--agent-id", "cluster-admin",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FIXTURE_LIST_USERS: JSON.stringify([
      { username: "cluster-admin", role: { permission: { super_user: true } } },
    ]) });
    expectRefused(home, result, "cluster-admin");
    expect(requestBodies(home).some((b: any) => b.operation === "deploy_component")).toBe(false);
  });

  test("remote provisioning: an unreserved agent id proceeds", () => {
    const home = tempDir("opi-prov-other-");
    const root = deployRoot(home);
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--cluster-admin-user", "cluster-admin", "--cluster-admin-pass", "fixture-cluster-pass",
      "--agent-id", "agent-a",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FIXTURE_LIST_USERS: JSON.stringify([
      { username: "cluster-admin", role: { permission: { super_user: false } } },
    ]) }, root);
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("administrator username reserved by this init path");
    expect(requestBodies(home).some((b: any) => b.operation === "deploy_component")).toBe(true);
  }, 120_000);

  test("remote init: the default administrator username is reserved and refused", () => {
    const home = tempDir("opi-remote-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "admin",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "admin");
  });

  test("remote init: --admin-user sets the reserved administrator username for an already-running instance", () => {
    const home = tempDir("opi-remote-user-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--admin-user", "operator-b", "--agent-id", "operator-b",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "operator-b");
  });

  test("remote init: FLAIR_ADMIN_USER sets the reserved administrator username when no flag is given", () => {
    const home = tempDir("opi-remote-env-");
    const result = runInit(home, [
      "init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
      "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "operator-c",
      "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ], { FLAIR_ADMIN_USER: "operator-c" });
    expectRefused(home, result, "operator-c");
  });

  test("local init: the default administrator username is reserved and refused", () => {
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
    expect(out).not.toContain("administrator username reserved by this init path");
  }, 60_000);
});
