/**
 * flair#3119 — `flair import`, `flair init` (local and `--target`) and
 * `flair agent rotate-key` refuse an id that fails the shared agent-ID rule
 * (src/lib/agent-id-rule.ts) BEFORE any key path is built.
 *
 * Each case runs the real CLI in a HOME-isolated child whose `fetch` records
 * every request to a file and answers 200. The home tree (the keys directory's
 * parent) is snapshotted before and after, so "no entry created or changed" is
 * the tree itself, and "no request sent" is the empty request log.
 *
 * Valid ids on the same paths are covered elsewhere: `flair import` by
 * agent-home-creation-paths-2474.test.ts, `flair init` by
 * init-operator-agent-id-3082.test.ts (the local and remote "proceeds" cases)
 * and init-skip-start-safety.test.ts, and `flair agent rotate-key` by
 * cli-message-flags.test.ts ("agent list and rotate-key warn only for inline
 * admin passwords").
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";

const CLI = pathToFileURL(join(import.meta.dir, "../../src/cli.ts")).href;
const ADMIN_PASS = "throwaway-admin-pass-not-a-secret";
const RULE_TEXT = "an agent id must match ^[a-zA-Z0-9_-]{1,64}$";

function runCli(home: string, args: string[]) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|TPS_TEST_ROOT$|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
  const script = `
    const { appendFileSync } = await import("node:fs");
    const log = ${JSON.stringify(join(home, "requests.jsonl"))};
    globalThis.fetch = async (input, init) => {
      appendFileSync(log, JSON.stringify({ url: String(input), method: init?.method ?? "GET" }) + "\\n");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { program } = await import(${JSON.stringify(CLI)});
    await program.parseAsync(${JSON.stringify(args)}, { from: "user" });
  `;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: home,
    env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise invalid-agent-id-3119 process fixture arguments" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** Every entry under `root`, with a file's content hash and a symlink's target. */
function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out.push(`${rel}@${readlinkSync(path)}`);
      else if (st.isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else {
        out.push(`${rel}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return out;
}

/** How many requests the child's `fetch` recorded (none creates no log file). */
function requestsSent(home: string): number {
  let text = "";
  try {
    text = readFileSync(join(home, "requests.jsonl"), "utf8");
  } catch {
    return 0;
  }
  return text.trim().split("\n").filter(Boolean).length;
}

function expectRefused(home: string, result: ReturnType<typeof runCli>, id: string, tree: string[]): void {
  const out = result.stdout + result.stderr;
  expect(result.status, out).toBe(1);
  expect(out).toContain(`Error: invalid agent id ${JSON.stringify(id)}: ${RULE_TEXT}`);
  expect(snapshotTree(home)).toEqual(tree);
  expect(requestsSent(home)).toBe(0);
}

const BAD_IDS = ["agent/one", ".."];

describe("flair#3119 — an invalid agent id is refused before its key path is built", () => {
  for (const id of BAD_IDS) {
    test(`flair import refuses the export's agent id ${JSON.stringify(id)}`, () => {
      const home = tempDir("iid-import-");
      const exportPath = join(home, "export.json");
      writeFileSync(exportPath, JSON.stringify({ type: "agent-export", agent: { id }, souls: [], memories: [] }));
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "import", exportPath,
        "--port", "1", "--ops-target", "http://127.0.0.1:1",
        "--admin-pass", ADMIN_PASS, "--keys-dir", join(home, "keys"),
      ]);
      expectRefused(home, result, id, baseline);
    }, 60_000);

    test(`flair agent rotate-key refuses the agent id ${JSON.stringify(id)}`, () => {
      const home = tempDir("iid-rotate-");
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "agent", "rotate-key", id,
        "--port", "1", "--ops-port", "1",
        "--admin-pass", ADMIN_PASS, "--keys-dir", join(home, "keys"),
      ]);
      expectRefused(home, result, id, baseline);
    }, 60_000);

    test(`flair init --agent-id refuses the agent id ${JSON.stringify(id)} on the local path`, () => {
      const home = tempDir("iid-init-local-");
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "init", "--agent-id", id, "--skip-start",
        "--data-dir", join(home, "data"), "--keys-dir", join(home, "keys"),
        "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
      ]);
      expectRefused(home, result, id, baseline);
    }, 60_000);

    test(`flair init --target --agent-id refuses the agent id ${JSON.stringify(id)} on the remote path`, () => {
      const home = tempDir("iid-init-remote-");
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "init", "--target", "http://127.0.0.1:1", "--ops-target", "http://127.0.0.1:1",
        "--force", "--admin-pass", ADMIN_PASS, "--agent-id", id,
        "--keys-dir", join(home, "keys"),
        "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
      ]);
      expectRefused(home, result, id, baseline);
    }, 60_000);
  }
});
