/**
 * Format parsers. Each format knows how to yield a stream of records
 * (plain objects) from a file. The runtime then applies the mapper to
 * each record independently.
 *
 * Slice 2 ships `jsonl` and `json`. `yaml` and `markdown-frontmatter`
 * land with slice 2b along with reference adapters that need them.
 */

import { promises as fsp } from "node:fs";
import yaml from "js-yaml";
import type { YamlFormat } from "../types.js";
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
      throw new BridgeRuntimeError({
        bridge,
        op: "import",
        path,
        field: "format",
        expected: "jsonl | json | yaml",
        got: "markdown-frontmatter",
        hint: "markdown-frontmatter parser lands in slice 2b along with its reference adapter",
      });
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
