/**
 * Format parsers. Each format knows how to yield a stream of records
 * (plain objects) from a file. The runtime then applies the mapper to
 * each record independently.
 *
 * Slice 2 ships `jsonl` and `json`. `yaml` and `markdown-frontmatter`
 * land with slice 2b along with reference adapters that need them.
 */

import { promises as fsp } from "node:fs";

import type { YamlFormat } from "../types.js";
import yaml from "js-yaml";
import { BridgeRuntimeError } from "../types.js";

export interface RecordWithLocation {
  record: unknown;
  /** 1-based record/line index for error reporting. */
  recordIndex: number;
}

export async function* parseRecords(
  bridge: string,
  path: string,
  format: YamlFormat,
): AsyncIterable<RecordWithLocation> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf-8");
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge,
      op: "import",
      path,
      field: "(source.path)",
      expected: "readable file",
      got: err?.code ?? "ENOENT",
      hint: `could not read source file: ${err?.message ?? err}`,
    });
  }

  switch (format) {
    case "jsonl":
      yield* parseJsonl(bridge, path, raw);
      return;
    case "json":
      yield* parseJson(bridge, path, raw);
      return;
    case "yaml":
      yield* parseYamlRecords(bridge, path, raw);
      return;
    case "markdown-frontmatter":
      yield* parseMarkdownFrontmatter(bridge, path, raw);
      return;
  }
}

// ─── jsonl ────────────────────────────────────────────────────────────────────

function* parseJsonl(bridge: string, path: string, raw: string): Iterable<RecordWithLocation> {
  const lines = raw.split(/\r?\n/);
  let recordIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    recordIndex++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: any) {
      throw new BridgeRuntimeError({
        bridge,
        op: "import",
        path,
        record: recordIndex,
        field: "(record)",
        expected: "valid JSON per line",
        got: truncate(line, 80),
        hint: `line ${i + 1} is not valid JSON: ${err?.message ?? err}`,
      });
    }
    yield { record: parsed, recordIndex };
  }
}

// ─── json ─────────────────────────────────────────────────────────────────────

function* parseJson(bridge: string, path: string, raw: string): Iterable<RecordWithLocation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge,
      op: "import",
      path,
      field: "(document)",
      expected: "valid JSON",
      got: truncate(raw, 80),
      hint: `JSON parse failed: ${err?.message ?? err}`,
    });
  }
  // Accept either an array of records or a single object; treat the single
  // object as an array of one.
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  let recordIndex = 0;
  for (const r of arr) {
    recordIndex++;
    yield { record: r, recordIndex };
  }
}

// ─── yaml (multi-doc) ─────────────────────────────────────────────────────────

function* parseYamlRecords(bridge: string, path: string, raw: string): Iterable<RecordWithLocation> {
  let docs: unknown[];
  try {
    docs = yaml.loadAll(raw);
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge,
      op: "import",
      path,
      field: "(document)",
      expected: "valid YAML",
      got: err?.name ?? "parse error",
      hint: `YAML parse failed: ${err?.message ?? err}`,
    });
  }
  let recordIndex = 0;
  for (const doc of docs) {
    if (doc === undefined || doc === null) continue;
    // Accept either a single doc that's an array, or multiple docs.
    const arr = Array.isArray(doc) ? doc : [doc];
    for (const r of arr) {
      recordIndex++;
      yield { record: r, recordIndex };
    }
  }
}

// ─── util ─────────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─── markdown-frontmatter ─────────────────────────────────────────────────────

/**
 * Parse a markdown file with optional front-matter.
 * Front-matter is YAML delimited by --- at the start of the file.
 * Returns an object with content, type, tags, subject, createdAt, derivedFrom.
 */
function* parseMarkdownFrontmatter(
  bridge: string,
  path: string,
  raw: string,
): Iterable<RecordWithLocation> {
  const lines = raw.split(/\r?\n/);
  
  // Check for front-matter delimiter
  if (!lines[0] || lines[0].trim() !== "---") {
    // No front-matter - treat entire file as content
    yield {
      record: {
        content: raw,
        type: "fact",
        subject: path.split("/").pop()?.replace(/\.md$/i, "") ?? "",
        createdAt: new Date().toISOString(),
        derivedFrom: [path],
        foreignId: path,
      },
      recordIndex: 1,
    };
    return;
  }
  
  // Skip the opening ---
  let i = 1;
  
  // Find closing ---
  let fmLines: string[] = [];
  while (i < lines.length) {
    if (lines[i]?.trim() === "---") {
      i++; // skip closing ---
      break;
    }
    fmLines.push(lines[i]);
    i++;
  }
  
  // Parse front-matter YAML
  let fm: Record<string, unknown>;
  try {
    const fmText = fmLines.join("\n");
    const parsed = yaml.load(fmText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("front-matter is not a valid YAML object");
    }
    fm = parsed as Record<string, unknown>;
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge,
      op: "import",
      path,
      record: 1,
      field: "front-matter",
      expected: "valid YAML",
      got: err?.name ?? "parse error",
      hint: `front-matter parse failed: ${err?.message ?? err}`,
    });
  }
  
  // Extract content (everything after front-matter)
  const content = lines.slice(i).join("\n");
  
  // Build record from front-matter with defaults
  let createdAt: string;
  if (fm.date instanceof Date) {
    createdAt = fm.date.toISOString();
  } else if (typeof fm.date === "string") {
    createdAt = fm.date;
  } else {
    createdAt = new Date().toISOString();
  }
  
  const record: Record<string, unknown> = {
    content,
    type: typeof fm.type === "string" ? fm.type : "fact",
    subject: typeof fm.title === "string" ? fm.title : path.split("/").pop()?.replace(/\.md$/i, "") ?? "",
    createdAt,
    derivedFrom: [path],
    foreignId: path, // Stable identifier for idempotent imports
  };
  
  // Handle tags - can be array or string
  if (typeof fm.tags === "string") {
    // Scalar string - split on comma or treat as single tag
    const tagStr = fm.tags.trim();
    if (tagStr.includes(",")) {
      record.tags = tagStr.split(/,\s*/).filter((t: string) => t.length > 0);
    } else if (tagStr.length > 0) {
      record.tags = [tagStr];
    }
  } else if (Array.isArray(fm.tags)) {
    record.tags = fm.tags.filter((t) => typeof t === "string");
  }
  
  yield { record, recordIndex: 1 };
}
