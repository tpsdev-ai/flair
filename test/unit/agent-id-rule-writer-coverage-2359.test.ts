/**
 * agent-id-rule-writer-coverage-2359.test.ts — flair#2359.
 *
 * The one agent-ID rule is only as good as the set of paths that apply it. This
 * test enumerates the files that use the direct Agent writer idioms it checks —
 * the resource raw table idiom (`(databases as any).flair.Agent.put(`), the two
 * structural resource writers the idiom cannot see (resources/Agent.ts's REST
 * methods go through `super`; resources/Federation.ts's merge resolves the table
 * through a variable), and the CLI's ops-API write literal in src/ — and requires
 * each to reference the shared guard from src/lib/agent-id-rule.ts. A caller that
 * creates an Agent through the REST API (`flair restore`) is not enumerated.
 *
 * The `flair agent add` CLI path is exercised behaviourally by
 * test/unit-isolated/agent-add-invalid-id-2359.test.ts; the shared CLI insert
 * helper (seedAgentViaOpsApi) is exercised directly below.
 */
import { expect, test, spyOn } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { seedAgentViaOpsApi } from "../../src/cli.js";

const SHARED_MODULE = "agent-id-rule.js";

/** The literal raw Agent write idiom, e.g. `(databases as any).flair.Agent.put(`. */
const RAW_AGENT_WRITE_RE = /\.flair\.Agent\.(put|post|patch)\s*\(/g;

/** The CLI's ops-API Agent write literal: a write `operation` on table "Agent". */
const OPS_AGENT_WRITE_RE = /operation:\s*"(insert|upsert|update)"[\s\S]{0,220}?table:\s*"Agent"/g;

/** Strip block + line comments so a doc example never counts as a write site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every file under `root` that matches one of the Agent write idioms. */
function agentWriterFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const src = stripComments(readFileSync(path, "utf8"));
        if (src.match(RAW_AGENT_WRITE_RE) || src.match(OPS_AGENT_WRITE_RE)) out.push(path);
      }
    }
  };
  walk(root);
  return out.sort();
}

test("the detector finds both write idioms (self-proof: synthetic writers are detected)", () => {
  const raw = "async function leak(id) {\n  await (databases as any).flair.Agent.put({ id });\n}\n";
  const ops = 'await fetch(url, { body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [] }) });\n';
  expect(stripComments(raw).match(RAW_AGENT_WRITE_RE)).not.toBeNull();
  expect(stripComments(ops).match(OPS_AGENT_WRITE_RE)).not.toBeNull();
});

test("the files using a checked direct Agent writer idiom reference the shared agent-ID rule", () => {
  // Structural writers the literal idioms cannot see.
  const structural = ["resources/Agent.ts", "resources/Federation.ts"];
  const files = [...new Set([...agentWriterFiles("resources"), ...agentWriterFiles("src"), ...structural])].sort();
  // The known writers must actually be detected — the enumeration is not vacuous.
  for (const expected of [
    "resources/AgentSeed.ts", "resources/XAA.ts", "resources/mcp-handler.ts",
    "src/cli.ts", "src/commands/principal.ts", "src/lib/mcp-enable.ts",
  ]) {
    expect(files, `${expected} is enumerated`).toContain(expected);
  }
  const missing: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(SHARED_MODULE) || !src.includes("isValidAgentId(")) missing.push(file);
  }
  expect(missing).toEqual([]);
});

test("each resource Agent write path runs the guard before it writes", () => {
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
  // flair#2441: an Agent row's merge is the plain put (only Memory goes through the write-back).
  expect(federation.indexOf("await table.put(mergedData)", skip)).toBeGreaterThan(skip);
});

test("seedAgentViaOpsApi refuses an out-of-rule id before any HTTP call", async () => {
  const calls: unknown[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (...args: unknown[]) => {
    calls.push(args);
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  try {
    await expect(seedAgentViaOpsApi(19925, "bad.id", "pubkey", "admin", "throwaway-pass")).rejects.toThrow(/invalid agent id/);
    expect(calls).toEqual([]);
  } finally {
    fetchSpy.mockRestore();
  }
});
