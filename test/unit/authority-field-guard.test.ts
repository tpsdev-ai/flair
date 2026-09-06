import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AUTHORITY_FIELDS, guardAuthorityFields, stripAuthorityFields } from "../../resources/authority-field-guard";

describe("workflow authority guard", () => {
  test("each verdict field rejects creation, replacement and clearing", async () => {
    for (const field of AUTHORITY_FIELDS.Memory) {
      for (const value of ["forged", null, ""]) {
        expect((await guardAuthorityFields(() => undefined, { [field]: value }, "Memory"))?.status).toBe(403);
        expect((await guardAuthorityFields(() => ({ [field]: "stored" }), { [field]: value }, "Memory"))?.status).toBe(403);
      }
    }
  });
  test("full-row echoes are unchanged; omitted stamps survive replacement writes", async () => {
    const stored = { promotionStatus: "approved", promotedAt: "2026-09-01", promotedBy: "reviewer" };
    const edit: Record<string, unknown> = { content: "edited", durability: "standard", archived: true };
    expect(await guardAuthorityFields(() => stored, edit, "Memory")).toBeNull();
    expect(edit).toMatchObject(stored);
    expect(await guardAuthorityFields(() => stored, { ...stored }, "Memory")).toBeNull();
  });
  test("a failed stored-state read cannot authorize a write", async () => {
    await expect(guardAuthorityFields(() => { throw new Error("unavailable"); }, {}, "Memory")).rejects.toThrow("unavailable");
  });
  test("every registered authority column exists and all write verbs delegate", () => {
    const schema = readFileSync("schemas/memory.graphql", "utf8");
    for (const [table, fields] of Object.entries(AUTHORITY_FIELDS)) {
      const body = schema.match(new RegExp(`type ${table}\\s[^]*?\\{([^]*?)\\n\\}`))?.[1] ?? "";
      for (const field of fields) expect(body).toContain(`${field}:`);
      const source = readFileSync(`resources/${table}.ts`, "utf8");
      for (const verb of ["post", "put", "patch"]) {
        const method = source.match(new RegExp(`async ${verb}\\([^]*?(?=\\n  (?:async |//)|$)`))?.[0] ?? "";
        expect(method).toContain("guardAuthorityFields");
      }
    }
  });
  test("stripAuthorityFields drops every registered stamp and leaves the rest", () => {
    const row: Record<string, unknown> = { content: "keep", promotionStatus: "approved", promotedAt: "t", promotedBy: "r", durability: "standard" };
    stripAuthorityFields(row, "Memory");
    expect(row).toEqual({ content: "keep", durability: "standard" });
  });
});

// ── Raw-handle coverage gate (#1524 leftover / design §9.2) ─────────────────
//
// guardAuthorityFields sits on Memory.put/patch/post, not the raw table.
// FeedMemories shipped unguarded because this gate did not enumerate those
// other writers. Scope is derived from the tree: every direct .put/.update,
// patchRecord first-arg, and alias-source write against flair.Memory must be
// classified. Unclassified → red. Federation merge is federation-merge (not
// a strip site) so a promoted row still syncs.

const RESOURCES_DIR = join(import.meta.dir, "..", "..", "resources");
const REPO_ROOT = join(import.meta.dir, "..", "..");

type WriterVia = "direct-put" | "direct-update" | "patchRecord" | "alias-source";
type WriterKind = "strip" | "federation-merge" | "trusted-stamp" | "echo" | "seed" | "single-field";

interface RawMemoryWriter {
  file: string;
  line: number;
  via: WriterVia;
  excerpt: string;
}

const CLASSIFICATIONS: Array<{ file: string; via: WriterVia; needle: string; kind: WriterKind }> = [
  { file: "resources/MemoryFeed.ts", via: "direct-put", needle: "put(record)", kind: "strip" },
  { file: "resources/Federation.ts", via: "alias-source", needle: "put(mergedData)", kind: "federation-merge" },
  { file: "resources/promotion-stamp.ts", via: "alias-source", needle: "put(row)", kind: "trusted-stamp" },
  { file: "resources/Memory.ts", via: "direct-put", needle: "put(closed)", kind: "echo" },
  { file: "resources/Memory.ts", via: "patchRecord", needle: "lastReflected", kind: "single-field" },
  { file: "resources/MemoryMaintenance.ts", via: "direct-update", needle: "update(record.id, archivedRow)", kind: "echo" },
  { file: "resources/usage-recording.ts", via: "direct-put", needle: "usageCount", kind: "echo" },
  { file: "resources/AgentSeed.ts", via: "direct-put", needle: "put(record)", kind: "seed" },
  { file: "resources/SemanticSearch.ts", via: "patchRecord", needle: "lastRetrieved", kind: "single-field" },
  { file: "resources/auth-middleware.ts", via: "patchRecord", needle: "embedding", kind: "single-field" },
  { file: "resources/MemoryReflect.ts", via: "patchRecord", needle: "lastReflected", kind: "single-field" },
  { file: "resources/migrations/visibility-backfill.ts", via: "alias-source", needle: "visibility: derived", kind: "echo" },
  { file: "resources/migrations/synthetic-test-migration.ts", via: "alias-source", needle: "SYNTHETIC_TARGET_MARKER", kind: "echo" },
];

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walkTs(full));
    else if (name.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Blank comment content, keep newlines so reported lines stay real. */
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function collectMemoryAliases(stripped: string): Set<string> {
  const aliases = new Set<string>();
  for (const m of stripped.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*\.flair\.Memory\b/g)) aliases.add(m[1]);
  for (const m of stripped.matchAll(/function\s+(\w+)\s*\([^)]*\)[\s\S]{0,240}?return\s+[^;\n]*\.flair\.Memory\b/g)) aliases.add(m[1]);
  for (const m of stripped.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\{[\s\S]{0,1200}?Memory\s*:\s*[^,\n]*\.flair\.Memory\b/g)) aliases.add(m[1]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of [...aliases]) {
      for (const m of stripped.matchAll(new RegExp(`\\b(\\w+)\\s*:\\s*\\(\\)\\s*=>\\s*\\w+\\s*=\\s*${alias}\\b`, "g"))) {
        if (!aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
      }
      for (const m of stripped.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${alias}\\s*\\(`, "g"))) {
        if (!aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
      }
      for (const m of stripped.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=[\\s\\S]{0,160}?\\b${alias}\\s*[\\[\\(]`, "g"))) {
        if (!aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
      }
    }
  }
  return aliases;
}

function enumerateRawMemoryWriters(): RawMemoryWriter[] {
  const writers: RawMemoryWriter[] = [];
  const seen = new Set<string>();
  const add = (w: RawMemoryWriter) => {
    const key = `${w.file}:${w.line}:${w.via}`;
    if (seen.has(key)) return;
    seen.add(key);
    writers.push(w);
  };
  for (const full of walkTs(RESOURCES_DIR)) {
    const file = relative(REPO_ROOT, full).replaceAll("\\", "/");
    const raw = readFileSync(full, "utf8");
    const stripped = stripComments(raw);
    const rawLines = raw.split("\n");
    const lines = stripped.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const excerpt = rawLines[i]?.trim() ?? "";
      if (/\.flair\.Memory\.put\s*\(/.test(line)) add({ file, line: i + 1, via: "direct-put", excerpt });
      if (/\.flair\.Memory\.update\s*\(/.test(line)) add({ file, line: i + 1, via: "direct-update", excerpt });
      if (/patchRecord(?:Silent)?\s*\(/.test(line) && /flair\.Memory/.test(line)) {
        add({ file, line: i + 1, via: "patchRecord", excerpt });
      }
    }
    const aliases = collectMemoryAliases(stripped);
    for (const alias of aliases) {
      const write = new RegExp(`\\b${alias}\\.(put|update)\\s*\\(`);
      for (let i = 0; i < lines.length; i++) {
        if (write.test(lines[i])) {
          add({
            file, line: i + 1,
            via: "alias-source",
            excerpt: rawLines[i]?.trim() ?? "",
          });
        }
      }
    }
  }
  return writers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function classify(writer: RawMemoryWriter) {
  return CLASSIFICATIONS.filter((c) => c.file === writer.file && c.via === writer.via && writer.excerpt.includes(c.needle));
}

describe("raw flair.Memory handle coverage", () => {
  const writers = enumerateRawMemoryWriters();

  test("the enumerator finds writers — a silent zero would make this gate vacuous", () => {
    expect(writers.length).toBeGreaterThan(5);
    expect(writers.some((w) => w.file === "resources/MemoryFeed.ts" && w.via === "direct-put")).toBe(true);
    expect(writers.some((w) => w.file === "resources/Federation.ts" && w.via === "alias-source" && w.excerpt.includes("mergedData"))).toBe(true);
  });

  test("every raw Memory writer is classified; unclassified goes red", () => {
    const unclassified = writers.filter((w) => classify(w).length === 0);
    expect(
      unclassified,
      `unclassified raw flair.Memory writers (this is the gate that would have caught FeedMemories): ${unclassified.map((w) => `${w.file}:${w.line} [${w.via}] ${w.excerpt}`).join(" | ")}`,
    ).toEqual([]);
  });

  test("every classification matches exactly one enumerated writer", () => {
    const stale: string[] = [];
    const dup: string[] = [];
    for (const c of CLASSIFICATIONS) {
      const matches = writers.filter((w) => w.file === c.file && w.via === c.via && w.excerpt.includes(c.needle));
      if (matches.length === 0) stale.push(`${c.file} [${c.via}] needle=${c.needle}`);
      if (matches.length > 1) dup.push(`${c.file} [${c.via}] needle=${c.needle} ×${matches.length}`);
    }
    expect(stale, `classification entries that match no writer: ${stale.join(" | ")}`).toEqual([]);
    expect(dup, `classification entries that match more than one writer: ${dup.join(" | ")}`).toEqual([]);
  });

  test("strip sites apply guard + unconditional strip; federation-merge does not strip", () => {
    for (const c of CLASSIFICATIONS.filter((x) => x.kind === "strip")) {
      expect(existsSync(join(REPO_ROOT, c.file)), c.file).toBe(true);
      const src = readFileSync(join(REPO_ROOT, c.file), "utf8");
      expect(src, `${c.file} is a strip site but does not call guardAuthorityFields`).toContain("guardAuthorityFields");
      expect(src, `${c.file} is a strip site but does not call stripAuthorityFields`).toContain("stripAuthorityFields");
    }
    for (const c of CLASSIFICATIONS.filter((x) => x.kind === "federation-merge")) {
      const src = readFileSync(join(REPO_ROOT, c.file), "utf8");
      expect(src, `${c.file} is federation-merge — stripping would drop a synced verdict`).not.toContain("stripAuthorityFields");
    }
  });

  test("FeedMemories is classified as a strip site; Federation merge is not", () => {
    const feed = CLASSIFICATIONS.find((c) => c.file === "resources/MemoryFeed.ts");
    const fed = CLASSIFICATIONS.find((c) => c.file === "resources/Federation.ts");
    expect(feed?.kind).toBe("strip");
    expect(fed?.kind).toBe("federation-merge");
  });
});
