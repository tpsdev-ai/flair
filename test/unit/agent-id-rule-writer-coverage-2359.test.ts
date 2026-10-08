/**
 * agent-id-rule-writer-coverage-2359.test.ts — flair#2359.
 *
 * The one agent-ID rule is only as good as the set of paths that apply it. This
 * test enumerates every file under resources/ that can create or rename an Agent
 * row — the literal raw-table idiom (`(databases as any).flair.Agent.put(`), plus
 * the two dynamic/structural writers the idiom cannot see (resources/Agent.ts's
 * REST methods go through `super`, and resources/Federation.ts's merge resolves
 * the table through a variable) — and requires each to reference the shared
 * guard from src/lib/agent-id-rule.ts.
 *
 * The CLI paths (src/commands/agent.ts, src/cli.ts) are covered by
 * test/unit-isolated/agent-add-invalid-id-2359.test.ts; the resource REST paths
 * by test/unit-isolated/agent-id-rule-resource-2359.test.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SHARED_IMPORT = "../src/lib/agent-id-rule.js";

/** The literal raw Agent write idiom, e.g. `(databases as any).flair.Agent.put(`. */
const RAW_AGENT_WRITE_RE = /\.flair\.Agent\.(put|post|patch)\s*\(/g;

/** Strip block + line comments so a doc example never counts as a write site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every resources/ file that matches the literal raw Agent write idiom. */
function rawAgentWriterFiles(root = "resources"): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        if (stripComments(readFileSync(path, "utf8")).match(RAW_AGENT_WRITE_RE)) out.push(path);
      }
    }
  };
  walk(root);
  return out.sort();
}

test("the detector finds a raw Agent write site (self-proof: a synthetic writer is detected)", () => {
  const synthetic = "async function leak(id) {\n  await (databases as any).flair.Agent.put({ id });\n}\n";
  expect(stripComments(synthetic).match(RAW_AGENT_WRITE_RE)).not.toBeNull();
});

test("every file that writes an Agent row references the shared agent-ID rule", () => {
  // Structural writers the literal idiom cannot see.
  const structural = ["resources/Agent.ts", "resources/Federation.ts"];
  const files = [...new Set([...rawAgentWriterFiles(), ...structural])].sort();
  // The known raw writers must actually be detected — the enumeration is not vacuous.
  for (const expected of ["resources/AgentSeed.ts", "resources/XAA.ts", "resources/mcp-handler.ts"]) {
    expect(files, `${expected} is enumerated`).toContain(expected);
  }
  const missing: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(SHARED_IMPORT) || !src.includes("isValidAgentId(")) missing.push(file);
  }
  expect(missing).toEqual([]);
});

test("each Agent write path runs the guard before it writes", () => {
  const agent = readFileSync("resources/Agent.ts", "utf8");
  for (const signature of ["  async post(content: any, context: any) {", "  async put(content: any) {", "  async patch(content: any, query?: any) {"]) {
    const start = agent.indexOf(signature);
    expect(start, `${signature} present`).toBeGreaterThan(-1);
    const nextMethod = agent.indexOf("\n  async ", start + 1);
    const nextPrivate = agent.indexOf("\n  private ", start + 1);
    const ends = [nextMethod, nextPrivate].filter((n) => n > start);
    const body = agent.slice(start, ends.length ? Math.min(...ends) : undefined);
    const check = body.indexOf("agentIdDenial(writeTargetId(this, content))");
    expect(check, `${signature} calls the guard`).toBeGreaterThan(-1);
    for (const write of ["super.post(", "super.put(", "super.patch("]) {
      const at = body.indexOf(write);
      if (at !== -1) expect(at, `${signature}: ${write} after the guard`).toBeGreaterThan(check);
    }
  }

  const seed = readFileSync("resources/AgentSeed.ts", "utf8");
  expect(seed.indexOf("isValidAgentId(agentId)")).toBeGreaterThan(-1);
  expect(seed.indexOf(".flair.Agent.put(")).toBeGreaterThan(seed.indexOf("isValidAgentId(agentId)"));

  const federation = readFileSync("resources/Federation.ts", "utf8");
  const skip = federation.indexOf("recordSkip(AGENT_ID_ERROR)");
  expect(skip).toBeGreaterThan(-1);
  expect(federation.indexOf("await table.put(", skip)).toBeGreaterThan(skip);
});
