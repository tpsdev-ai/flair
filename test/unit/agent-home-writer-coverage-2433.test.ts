/**
 * agent-home-writer-coverage-2433.test.ts — flair#2433.
 *
 * Checks source text for home helpers in files matching the ops-API Agent
 * insert/upsert pattern, and in the named resource and seed-based creator files.
 * Row-level behavior is covered by separate tests.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The CLI's ops-API Agent create literal: an insert/upsert on table "Agent". */
const OPS_AGENT_CREATE_RE = /operation:\s*"(insert|upsert)"[\s\S]{0,300}?table:\s*"Agent"/g;

/** Remove block and line comments before matching source text. */
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

test("files matching the ops-API Agent create pattern name shared home helpers", () => {
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

test("the Agent resource and named raw creator files contain the shared delegate call text", () => {
  expect(readFileSync("resources/Agent.ts", "utf8")).toContain("stampOriginatorOnCreate(");
  for (const file of ["resources/AgentSeed.ts", "resources/XAA.ts", "resources/mcp-handler.ts"]) {
    expect(readFileSync(file, "utf8"), `${file} stamps via the shared helper`).toContain("stampOriginatorOnCreate(");
  }
});

/**
 * flair#2474 — the writer-coverage test above sees only the file that carries
 * the ops-API create literal (cli.ts). A creation path that creates its Agent
 * row by CALLING the shared seed is invisible to it. This checks the source of
 * the THREE seed-based creation paths it names by file
 * (`src/commands/agent.ts`, `src/commands/init.ts`, `src/commands/import.ts`) by
 * TEXT: each must name an awaited STAMPING seed call (`seedAgentWithLocalHome`),
 * and must not name a call to the
 * home-less seed directly. The rows those paths create are asserted by
 * test/unit-isolated/agent-home-creation-paths-2474 (agent add, import), the
 * remote-init isolated test, and test/integration/agent-home-2433 (the seed
 * itself). The check is a text match over the RAW source, so it does NOT by
 * itself exclude a commented-out or otherwise unreachable `await
 * seedAgentWithLocalHome(` from satisfying it, and it says nothing about any
 * seed-based creation path NOT in that list.
 */
test("the named seed-based CLI Agent creation files contain awaited home-stamping seed calls", () => {
  const paths = ["src/commands/agent.ts", "src/commands/init.ts", "src/commands/import.ts"];
  for (const file of paths) {
    const src = readFileSync(file, "utf8");
    // The home-stamping seed must appear as an AWAITED call in the file's text.
    expect(src, `${file} names an awaited home-stamping seed call`).toContain("await seedAgentWithLocalHome(");
    // The home-less seed may survive ONLY as its own passthrough definition
    // (`function seedAgentViaOpsApi(...args) { return cli.seedAgentViaOpsApi(...args); }`).
    // Strip EXACTLY that definition, then any remaining call — including a
    // `cli.seedAgentViaOpsApi(` call, which the old blanket strip used to hide
    // (flair#2474) — fails. Read the RAW source so a mis-stripped block cannot
    // hide the call.
    const rest = src.replace(
      /function\s+seedAgentViaOpsApi\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{\s*return\s+cli\.seedAgentViaOpsApi\([^)]*\);\s*\}/g,
      "\u0000",
    );
    expect(rest.includes("seedAgentViaOpsApi("), `${file} names a home-less seed call outside its passthrough definition`).toBe(false);
  }
});
