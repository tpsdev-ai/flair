import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

/** `flair init --target <hub> --remote --agent-id` against an in-memory ops API. */
function runRemoteInit(home: string, options: { observeFirstWrite?: string; umaskZero?: boolean; operatorAgentRow?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const args = ["init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
    "--remote", "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "hub-first",
    "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md"];
  const script = `
    ${options.umaskZero ? "process.umask(0);" : ""}
    const { appendFileSync, fstatSync } = await import("node:fs");
    ${options.observeFirstWrite
      ? `const keyFile = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../src/lib/agent-key-file.js")).href)});
    keyFile.setAgentKeyFileTestHooks({ beforeFirstWrite: (fd) => appendFileSync(${JSON.stringify(options.observeFirstWrite)}, String(fstatSync(fd).mode & 0o777) + "\\n") });`
      : ""}
    const log = ${JSON.stringify(join(home, "ops.jsonl"))};
    const operatorAgentRow = ${JSON.stringify(options.operatorAgentRow ?? false)};
    let instances = [];
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init && typeof init.body === "string" && init.body.startsWith("{")) {
        const body = JSON.parse(init.body);
        if (body.operation) {
          appendFileSync(log, JSON.stringify(body) + "\\n");
          if (body.operation === "sql") return json(instances);
          if (body.operation === "insert" && body.table === "Instance") { instances = [...instances, ...body.records]; return json({ inserted_hashes: [] }); }
          return json({});
        }
      }
      if (url.pathname === "/Health") return json({ ok: true });
      // A real server answers an absent record with 404, not a body.
      if (operatorAgentRow && url.pathname.startsWith("/Agent/")) {
        return json({ id: decodeURIComponent(url.pathname.slice("/Agent/".length)) });
      }
      if (/^\\/(Memory|Agent|OrgSkillAssignment)\\//.test(url.pathname)) return json({}, 404);
      return json({});
    };
    const { program } = await import(${JSON.stringify(CLI)});
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  return spawnSync(process.execPath, ["-e", script], { cwd: home, env: { ...(env), FLAIR_TEST_ALLOW_BUN_HARPER: "exercise init-remote-agent-home-2433 process fixture arguments" }, encoding: "utf8", timeout: 30_000 });
}

describe("flair init --remote stamps the hub's own id on the first agent (flair#2433)", () => {
  test("the Instance row is reconciled before the agent seed, so the agent's home is the hub's instance id", () => {
    const home = tempDir("irh-");
    const result = runRemoteInit(home);
    const out = result.stdout + result.stderr;
    const logPath = join(home, "ops.jsonl");
    expect(existsSync(logPath), out).toBe(true);
    const ops = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const instanceInsert = ops.find((o) => o.operation === "insert" && o.table === "Instance");
    const agentInsert = ops.find((o) => o.operation === "insert" && o.table === "Agent");
    expect(instanceInsert, out).toBeDefined();
    expect(agentInsert, out).toBeDefined();
    expect(ops.indexOf(instanceInsert)).toBeLessThan(ops.indexOf(agentInsert));
    expect(agentInsert.records[0].originatorInstanceId).toBe(instanceInsert.records[0].id);
  }, 60_000);

  test("a pre-created 0644 key is refused before the agent seed and stays byte-for-byte unchanged", () => {
    const home = tempDir("irh-wide-");
    const keyPath = join(home, "keys", "hub-first.key");
    mkdirSync(join(home, "keys"), { recursive: true });
    const prior = Buffer.alloc(32, 8);
    writeFileSync(keyPath, prior);
    chmodSync(keyPath, 0o644);

    const result = runRemoteInit(home);
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(1);
    expect(out).toContain(`chmod 600 ${keyPath}`);
    expect(readFileSync(keyPath).equals(prior)).toBe(true);
    const logPath = join(home, "ops.jsonl");
    const ops = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    expect(ops.some((entry) => entry.operation === "insert")).toBe(false);
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);
  }, 60_000);

  test("an Agent record with the operator's id refuses the run before the first write", () => {
    const home = tempDir("irh-opsagent-");
    const result = runRemoteInit(home, { operatorAgentRow: true });
    const out = result.stdout + result.stderr;
    expect(result.status, out).toBe(1);
    expect(out).toContain(`an Agent record has the operator's id "admin"`);
    const logPath = join(home, "ops.jsonl");
    const ops = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    expect(ops.some((entry) => entry.operation === "insert")).toBe(false);
  }, 60_000);

  test("a fresh key is 0600 at its first write under a zero umask", () => {
    const home = tempDir("irh-mode-");
    const observed = join(home, "first-write.txt");
    const result = runRemoteInit(home, { observeFirstWrite: observed, umaskZero: true });
    expect(existsSync(observed), result.stdout + result.stderr).toBe(true);
    const modes = readFileSync(observed, "utf8").trim().split("\n").map(Number);
    expect(modes).toEqual([0o600]);
    expect(statSync(join(home, "keys", "hub-first.key")).mode & 0o777).toBe(0o600);
  }, 60_000);
});
