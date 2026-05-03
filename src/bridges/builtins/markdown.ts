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
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parseRecords } from "../runtime/formats.js";
import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

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
  
  for (const filePath of files) {
    ctx.log.debug(`processing file`, { path: filePath });
    
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf-8");
    } catch (err: any) {
      ctx.log.warn(`could not read file, skipping`, { path: filePath, error: err?.message });
      continue;
    }
    
    // Use parseRecords from formats.ts for consistent parsing
    const parser = parseRecords("markdown", filePath, "markdown-frontmatter");
    for await (const { record } of parser) {
      yield record as BridgeMemory;
    }
  }
}

// Export as a code-plugin MemoryBridge (Shape B)
export const markdownMemoryBridge: MemoryBridge = {
  name: "markdown",
  version: 1,
  kind: "file",
  description: "Import markdown files with front-matter into Flair memories",
  import: importFromDirectory,
};
