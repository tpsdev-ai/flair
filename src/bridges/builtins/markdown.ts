/**
 * Built-in bridge: markdown
 *
 * Imports markdown files from a directory into Flair memories.
 * Each .md file becomes one memory with content sans front-matter,
 * type/tags/subject/createdAt derived from front-matter fields.
 *
 * Round-trip stable: export produces equivalent markdown files.
 */

import { promises as fsp } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import yaml from "js-yaml";

export const markdownDescriptor: {
  import?: undefined;
  export?: undefined;
} = {};

export async function* importFromDirectory(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  // Resolve source directory
  const sourceDir: string =
    typeof opts.source === "string" ? opts.source : join(homedir(), "notes");
  
  ctx.log.info(`scanning markdown directory`, { path: sourceDir });
  
  // Scan directory for .md files
  let files: string[];
  try {
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => join(sourceDir, e.name));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      ctx.log.warn(`source directory does not exist`, { path: sourceDir });
      return;
    }
    throw new BridgeRuntimeError({
      bridge: "markdown",
      op: "import",
      field: "source",
      expected: "readable directory",
      got: err?.code ?? "error",
      hint: `could not read source directory ${sourceDir}: ${err?.message ?? err}`,
    });
  }
  
  ctx.log.info(`found markdown files`, { count: files.length });
  
  let ordinal = 0;
  for (const filePath of files) {
    ordinal++;
    ctx.log.debug(`processing file`, { path: filePath });
    
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf-8");
    } catch (err: any) {
      ctx.log.warn(`could not read file, skipping`, { path: filePath, error: err?.message });
      continue;
    }
    
    const record = parseMarkdownRecord(filePath, raw);
    yield record;
  }
}

function parseMarkdownRecord(filePath: string, raw: string): BridgeMemory {
  const lines = raw.split(/\r?\n/);
  
  // Check for front-matter delimiter
  if (!lines[0] || lines[0].trim() !== "---") {
    // No front-matter - treat entire file as content
    return {
      content: raw,
      type: "fact",
      subject: basename(filePath).replace(/\.md$/i, ""),
      createdAt: new Date().toISOString(),
      derivedFrom: [filePath],
    };
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
      bridge: "markdown",
      op: "import",
      path: filePath,
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
  
  const record: BridgeMemory = {
    content,
    type: typeof fm.type === "string" ? fm.type : "fact",
    subject: typeof fm.title === "string" ? fm.title : basename(filePath).replace(/\.md$/i, ""),
    createdAt,
    derivedFrom: [filePath],
    foreignId: filePath, // Stable identifier for idempotent imports
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
  
  return record;
}

// Export as a code-plugin MemoryBridge (Shape B)
export const markdownMemoryBridge: MemoryBridge = {
  name: "markdown",
  version: 1,
  kind: "file",
  description: "Import markdown files with front-matter into Flair memories",
  import: importFromDirectory,
};
