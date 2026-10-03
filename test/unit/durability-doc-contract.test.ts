import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

const CANONICAL_TIERS: readonly string[] = [
  "permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays and is considered before recent rows in bootstrap, subject to scope, expiry/closure and the token budget.",
  "persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it).",
  "standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
];

const CANONICAL_CAVEAT =
  "No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.";

const CANONICAL: readonly string[] = [...CANONICAL_TIERS, CANONICAL_CAVEAT];

const SURFACES: readonly string[] = [
  "resources/memory-durability.ts",
  "packages/flair-tool-descriptors/src/index.ts",
  "resources/tool-descriptors/index.ts",
  "packages/flair-mcp/src/tool-descriptors/index.ts",
  "src/lib/durability-copy.ts",
  "src/lib/using-flair-skill.ts",
  "test/unit-isolated/cli-surface.snapshot.txt",
  "packages/flair-client/src/types.ts",
  "packages/flair-client/src/client.ts",
  "packages/adk-flair-js/src/memory_service.ts",
  "packages/adk-flair/src/adk_flair/memory_service.py",
  "packages/adk-flair/README.md",
  "src/bridges/types.ts",
  "packages/pi-flair/src/index.ts",
  "packages/openclaw-flair/index.ts",
  "packages/hermes-flair/__init__.py",
  "packages/n8n-nodes-flair/src/nodes/FlairWrite/FlairWrite.node.ts",
  "packages/cursor-flair/skills/remember/SKILL.md",
  "README.md",
  "DESIGN.md",
  "docs/api-reference.md",
  "docs/bridges.md",
  "docs/rem.md",
  "docs/quickstart.md",
  "docs/claude-code.md",
];

/**
 * Guarantees the code does NOT provide, checked per raw line. A line is a
 * violation only when it also names a durability tier, so unrelated prose
 * ("this port is not guaranteed distinct", "never deleted" in a test note) is
 * not a false positive.
 */
const TIER_WORD = /(?:durab|permanent|persistent|ephemeral|retention)/i;
const FORBIDDEN: readonly RegExp[] = [
  /until explicitly deleted/i,
  /guaranteed/i,
  /never lost/i,
  /never be deleted/i,
  /never deleted/i,
  /cannot be deleted/i,
  /can not be deleted/i,
  /can't be deleted/i,
  /permanent(?:ly)? stor(?:e|ed|age)/i,
  /inviolable/i,
  /never-forget/i,
  /survives indefinitely|forever/i,
];

/** Collapse all whitespace so a wrapped/multi-line statement still matches. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

function read(repoRelPath: string): string | null {
  try {
    return readFileSync(join(REPO, repoRelPath), "utf8");
  } catch {
    return null;
  }
}

/** Missing canonical lines in one file's text. */
function missingCanonical(text: string): string[] {
  const flat = squash(text);
  return CANONICAL.filter((line) => !flat.includes(squash(line)));
}

/** Forbidden over-promises in one file's text. */
function forbiddenHits(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (TIER_WORD.test(raw) && FORBIDDEN.some((re) => re.test(raw))) hits.push(raw.trim());
  }
  return hits;
}

function runText(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

describe("flair#2217 — durability documentation contract", () => {
  test("the canonical statement is one line per tier plus a caveat", () => {
    expect(CANONICAL_TIERS).toHaveLength(4);
    for (const tier of ["permanent", "persistent", "standard", "ephemeral"]) {
      expect(CANONICAL_TIERS.filter((l) => l.startsWith(`${tier} —`))).toHaveLength(1);
    }
    expect(CANONICAL_CAVEAT.length).toBeGreaterThan(0);
  });

  test(`each enumerated file carries the canonical statement (${SURFACES.length} files)`, () => {
    const failures: string[] = [];
    for (const file of SURFACES) {
      const text = read(file);
      if (text === null) {
        failures.push(`${file}: MISSING FILE (run node scripts/vendor-tool-descriptors.mjs for vendored artifacts)`);
        continue;
      }
      for (const line of missingCanonical(text)) {
        failures.push(`${file}: dropped canonical line -> ${line.slice(0, 60)}…`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("listed files contain no forbidden durability wording", () => {
    const failures: string[] = [];
    for (const file of SURFACES) {
      const text = read(file);
      if (text === null) continue; // reported by the previous test
      for (const hit of forbiddenHits(text)) {
        failures.push(`${file}: ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("MCP memory_store displays the canonical durability description", () => {
    const descriptions: string[] = JSON.parse(runText([process.execPath, "-e", `
      const descriptions = [];
      for (const path of ${JSON.stringify([
        "packages/flair-tool-descriptors/src/index.ts",
        "resources/tool-descriptors/index.ts",
        "packages/flair-mcp/src/tool-descriptors/index.ts",
      ])}) {
        const { TOOL_DESCRIPTORS } = await import("./" + path);
        const tool = TOOL_DESCRIPTORS.find(t => t.name === "memory_store");
        descriptions.push(tool.inputSchema.properties.durability.description);
      }
      console.log(JSON.stringify(descriptions));
    `]));
    expect(descriptions).toHaveLength(3);
    for (const description of descriptions) {
      expect(missingCanonical(description)).toEqual([]);
      expect(forbiddenHits(description)).toEqual([]);
    }
  });

  test("CLI durability options display Memory copy or Soul PUT semantics", () => {
    const help: string[] = JSON.parse(runText([process.execPath, "-e", `
      const { program } = await import("./src/cli.ts");
      const { captureCommandHelp } = await import("./test/helpers/cli-surface.ts");
      const commands = [
        program.commands.find(c => c.name() === "memory").commands.find(c => c.name() === "add"),
        program.commands.find(c => c.name() === "search"),
        program.commands.find(c => c.name() === "soul").commands.find(c => c.name() === "set"),
      ];
      console.log(JSON.stringify(commands.map(cmd => {
        const option = cmd.options.find(o => o.long === "--durability");
        if (!option) throw new Error("missing durability option");
        cmd.options = [option];
        return captureCommandHelp(cmd);
      })));
    `]));
    expect(help).toHaveLength(3);
    for (const text of help.slice(0, 1)) {
      expect(missingCanonical(text)).toEqual([]);
      expect(forbiddenHits(text)).toEqual([]);
    }
    expect(squash(help[1])).toContain(
      "Filter results by durability (permanent/persistent/standard/ephemeral; comma-separated; client-side). " + CANONICAL_CAVEAT,
    );
    expect(help[1]).not.toContain("routine maintenance");
    expect(forbiddenHits(help[1])).toEqual([]);
    expect(squash(help[2])).toContain(
      "Stored Soul label (permanent/persistent/standard/ephemeral). Soul has no expiresAt/validTo and is not scanned by MemoryMaintenance. PUT supplies no default; omitted durability is unset.",
    );
    expect(help[2]).not.toContain("routine maintenance");
  });

  test("Python ADK add_memory docstring displays the canonical durability copy", () => {
    const docstring = runText(["python3", "-c", `
import ast
from pathlib import Path
tree = ast.parse(Path("packages/adk-flair/src/adk_flair/memory_service.py").read_text())
methods = [node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef) and node.name == "add_memory"]
assert len(methods) == 1
print(ast.get_docstring(methods[0]) or "")
    `]);
    expect(missingCanonical(docstring)).toEqual([]);
    expect(forbiddenHits(docstring)).toEqual([]);
  });

  test("guard the guard: the checker flags the pre-#2217 README claim", () => {
    const overPromise =
      "| **Tiered durability** | `permanent` (retained until explicitly deleted by its owner or an admin) / `persistent` / `standard` (default) / `ephemeral` (24h TTL). |";
    expect(forbiddenHits(overPromise)).not.toEqual([]);
    for (const claim of ["persistent — survives indefinitely", "permanent — retained forever"]) {
      expect(forbiddenHits(claim)).not.toEqual([]);
    }
    // And a compliant line is not flagged.
    expect(forbiddenHits(`- ${CANONICAL_TIERS[0]}`)).toEqual([]);
    expect(missingCanonical(CANONICAL.join("\n"))).toEqual([]);
  });
});
