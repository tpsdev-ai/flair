/**
 * agent-home-writer-coverage-2433.test.ts — flair#2433.
 *
 * The home-instance stamp is only as good as the set of creation paths that
 * apply it. The Agent resource stamps on every create (resources/Agent.ts, via
 * resources/originator-instance.ts); the resource RAW writers (AgentSeed, XAA,
 * mcp-handler) are enumerated by test/unit/originator-instance-writer-coverage.test.ts.
 *
 * This test enumerates the CLI's ops-API Agent creation literal in src/ — a write
 * `operation` of insert/upsert on table "Agent" — and requires each file to reach
 * the ONE shared home rule from src/lib/agent-home.ts. A file that creates Agent
 * rows must reach the stamping rule; record-level stamping is pinned by the
 * per-creator tests.
 *
 * The `update` idiom is deliberately NOT enumerated: an update on an Agent row is
 * not a creation, and the CLI's updates (principal status, key rotation) name
 * only their own fields.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The CLI's ops-API Agent create literal: an insert/upsert on table "Agent". */
const OPS_AGENT_CREATE_RE = /operation:\s*"(insert|upsert)"[\s\S]{0,300}?table:\s*"Agent"/g;

/** Strip block + line comments so a doc example never counts as a write site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every file under `root` that matches the ops-API Agent create idiom. */
function agentCreateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        if (stripComments(readFileSync(path, "utf8")).match(OPS_AGENT_CREATE_RE)) out.push(path);
      }
    }
  };
  walk(root);
  return out.sort();
}

test("the detector finds the ops-API Agent create idiom (self-proof)", () => {
  const synthetic = 'await fetch(url, { body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [] }) });\n';
  expect(stripComments(synthetic).match(OPS_AGENT_CREATE_RE)).not.toBeNull();
});

test("every src/ ops-API Agent creation path applies the shared home rule", () => {
  const files = agentCreateFiles("src");
  // The known creation paths must actually be detected — the enumeration is not
  // vacuous.
  for (const expected of [
    "src/cli.ts",
    "src/commands/mcp.ts",
    "src/commands/principal.ts",
    "src/lib/mcp-enable.ts",
  ]) {
    expect(files, `${expected} is enumerated`).toContain(expected);
  }
  const missing: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const reachesRule = src.includes("agent-home.js") &&
      (src.includes("resolveTargetInstanceId(") || src.includes("stampAgentHome("));
    if (!reachesRule) missing.push(file);
  }
  expect(missing).toEqual([]);
});

test("the Agent resource and its raw creators stamp through the one delegate", () => {
  expect(readFileSync("resources/Agent.ts", "utf8")).toContain("stampOriginatorOnCreate(");
  for (const file of ["resources/AgentSeed.ts", "resources/XAA.ts", "resources/mcp-handler.ts"]) {
    expect(readFileSync(file, "utf8"), `${file} stamps via the shared helper`).toContain("stampOriginatorOnCreate(");
  }
});
