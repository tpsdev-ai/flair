/**
 * flair#3119 — `flair import`, `flair init` (local and `--target`) and
 * `flair agent rotate-key` refuse an id that fails the shared agent-ID rule
 * (src/lib/agent-id-rule.ts) before the keys directory or any key file is
 * created or written, and before any `fetch` call was made.
 *
 * Each case runs the real CLI in a HOME-isolated child whose overridden `fetch`
 * records every `fetch` call to a file and answers 200. The home tree (the keys
 * directory's parent) is snapshotted before and after; the snapshot holds entry
 * names, each file's SHA-256 content hash and each symlink's target — not modes,
 * timestamps or reads — so it shows no entry added or removed and no file
 * content or link target changed. "no `fetch` call was made" is the empty log
 * file.
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

/** How many `fetch` calls the child recorded; no log file means 0. */
function requestsSent(home: string): number {
  let text = "";
  try {
    text = readFileSync(join(home, "requests.jsonl"), "utf8");
  } catch {
    return 0;
  }
  return text.trim().split("\n").filter(Boolean).length;
}

function expectRefusedWith(
  home: string,
  result: ReturnType<typeof runCli>,
  tree: string[],
  message: string,
): void {
  const out = result.stdout + result.stderr;
  expect(result.status, out).toBe(1);
  expect(out).toContain(message);
  expect(snapshotTree(home)).toEqual(tree);
  expect(requestsSent(home)).toBe(0);
}

function expectRefused(home: string, result: ReturnType<typeof runCli>, id: string, tree: string[]): void {
  expectRefusedWith(home, result, tree, `Error: invalid agent id ${JSON.stringify(id)}: ${RULE_TEXT}`);
}

const BAD_IDS = ["agent/one", ".."];

describe("flair#3119 — an invalid agent id is refused before its keys directory or key file is created", () => {
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

    test(`flair init --target --cluster-admin-user --agent-id refuses the agent id ${JSON.stringify(id)} on the provisioning leg`, () => {
      const home = tempDir("iid-init-provision-");
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "init", "--target", "http://127.0.0.1:1", "--ops-target", "http://127.0.0.1:1",
        "--cluster-admin-user", "cluster-admin-a", "--cluster-admin-pass", "throwaway-cluster-pass",
        "--force", "--agent-id", id,
        "--keys-dir", join(home, "keys"),
        "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
      ]);
      expectRefused(home, result, id, baseline);
    }, 60_000);
  }
});
/**
 * A present non-string id in an export is refused before the shared rule:
 * `String(0)` and `String(123)` each match the rule, so a rule message would
 * misdescribe the refusal.
 */
describe("flair#3119 — a present non-string agent id in an export is refused", () => {
  for (const id of [0, 123]) {
    test(`flair import refuses the numeric agent id ${id}`, () => {
      const home = tempDir("iid-nonstring-import-");
      const exportPath = join(home, "export.json");
      writeFileSync(exportPath, JSON.stringify({ type: "agent-export", agent: { id }, souls: [], memories: [] }));
      const baseline = snapshotTree(home);
      const result = runCli(home, [
        "import", exportPath,
        "--port", "1", "--ops-target", "http://127.0.0.1:1",
        "--admin-pass", ADMIN_PASS, "--keys-dir", join(home, "keys"),
      ]);
      expectRefusedWith(home, result, baseline, "Error: agent id in export must be a string (got number)");
    }, 60_000);
  }
});
/**
 * A supplied empty id is a supplied value: it must reach the shared rule, not
 * the "omitted" branches of `flair import` and `flair init`.
 */
describe("flair#3119 — a supplied empty agent id is refused by the shared rule", () => {
  const INVALID_EMPTY = `Error: invalid agent id "": ${RULE_TEXT}`;

  test("flair import refuses an empty agent id in the export", () => {
    const home = tempDir("iid-empty-import-");
    const exportPath = join(home, "export.json");
    writeFileSync(exportPath, JSON.stringify({ type: "agent-export", agent: { id: "" }, souls: [], memories: [] }));
    const baseline = snapshotTree(home);
    const result = runCli(home, [
      "import", exportPath,
      "--port", "1", "--ops-target", "http://127.0.0.1:1",
      "--admin-pass", ADMIN_PASS, "--keys-dir", join(home, "keys"),
    ]);
    expectRefused(home, result, "", baseline);
    expect(result.stdout + result.stderr).toContain(INVALID_EMPTY);
  }, 60_000);

  test("flair init --agent-id refuses an empty agent id on the local path", () => {
    const home = tempDir("iid-empty-init-local-");
    const baseline = snapshotTree(home);
    const result = runCli(home, [
      "init", "--agent-id", "", "--skip-start",
      "--data-dir", join(home, "data"), "--keys-dir", join(home, "keys"),
      "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "", baseline);
  }, 60_000);

  test("flair init --target --agent-id refuses an empty agent id on the already-running remote leg", () => {
    const home = tempDir("iid-empty-init-remote-");
    const baseline = snapshotTree(home);
    const result = runCli(home, [
      "init", "--target", "http://127.0.0.1:1", "--ops-target", "http://127.0.0.1:1",
      "--force", "--admin-pass", ADMIN_PASS, "--agent-id", "",
      "--keys-dir", join(home, "keys"),
      "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "", baseline);
  }, 60_000);

  test("flair init --target --cluster-admin-user --agent-id refuses an empty agent id on the provisioning leg", () => {
    const home = tempDir("iid-empty-init-provision-");
    const baseline = snapshotTree(home);
    const result = runCli(home, [
      "init", "--target", "http://127.0.0.1:1", "--ops-target", "http://127.0.0.1:1",
      "--cluster-admin-user", "cluster-admin-a", "--cluster-admin-pass", "throwaway-cluster-pass",
      "--force", "--agent-id", "",
      "--keys-dir", join(home, "keys"),
      "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ]);
    expectRefused(home, result, "", baseline);
  }, 60_000);
});
