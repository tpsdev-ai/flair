import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;

/** `flair init --target <hub> --remote --agent-id` against an in-memory ops API. */
function runRemoteInit(home: string) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const args = ["init", "--target", "http://hub.invalid:9926", "--ops-target", "http://hub.invalid:9925",
    "--remote", "--force", "--admin-pass", "fixture-admin-pass", "--agent-id", "hub-first",
    "--keys-dir", join(home, "keys"), "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md"];
  const script = `
    const { appendFileSync } = await import("node:fs");
    const log = ${JSON.stringify(join(home, "ops.jsonl"))};
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
      return json({});
    };
    const { program } = await import(${JSON.stringify(CLI)});
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  return spawnSync(process.execPath, ["-e", script], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
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
});
