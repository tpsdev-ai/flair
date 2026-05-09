/**
 * Built-in bridge: claude-project
 *
 * Imports a Claude project export into Flair memories. A Claude project
 * export contains `memory.json` (the memories array) and optionally
 * `project.json` (metadata about the project, including its name).
 *
 * Each memory becomes one Flair memory tagged `source:claude-project` +
 * `import:claude-project`. When project.json is present, the project's
 * name is used as the subject; foreignId embeds the project name for
 * cross-project dedup.
 *
 * Why Shape B (code) not Shape A (YAML):
 * - The export may or may not have project.json — conditional logic is
 *   cleaner in TS.
 * - We derive subject and foreignId from project metadata at runtime.
 *
 * Source shapes accepted:
 *   1. A directory containing `memory.json` (the Claude project export root)
 *   2. A direct path to `memory.json`
 *   3. The wrapper `{ memories: [...] }` OR a top-level array (same as ChatGPT)
 *
 * Usage:
 *   flair bridge import claude-project --source ./claude-export --agent <flair-id>
 */

import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

interface RawClaudeMemory {
  id?: string;
  content?: string;
  text?: string;
  created_at?: string;
}

interface RawClaudeProject {
  name?: string;
  [key: string]: unknown;
}

async function* importClaudeProject(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  // Resolve source path
  const { isAbsolute, resolve } = await import("node:path");
  const sourceArg = typeof opts.source === "string" ? opts.source : "";
  if (!sourceArg) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: "(unset)",
      field: "source",
      expected: "path to memory.json or to the Claude project export directory",
      got: "missing",
      hint: "pass --source <path>; example: flair bridge import claude-project --source ./claude-export --agent <id>",
    });
  }
  const sourceAbs = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  let filePath: string;
  let sourceDir: string;
  try {
    const stat = await fsp.stat(sourceAbs);
    if (stat.isDirectory()) {
      sourceDir = sourceAbs;
      filePath = join(sourceAbs, "memory.json");
    } else {
      sourceDir = dirname(sourceAbs);
      filePath = sourceAbs;
    }
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: sourceAbs,
      field: "source",
      expected: "readable file or directory containing memory.json",
      got: err?.code ?? "ENOENT",
      hint: `could not resolve source: ${err?.message ?? err}`,
    });
  }

  // If the resolved file ends in .zip, give a friendly error
  if (filePath.endsWith(".zip")) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "source",
      expected: "extracted directory or memory.json file",
      got: "zip archive",
      hint: `extract the .zip first, then point --source at the extracted directory:\n  unzip ${filePath} -d ./claude-export && flair bridge import claude-project --source ./claude-export --agent <id>`,
    });
  }

  ctx.log.info("reading Claude project memory dump", { path: filePath });

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "source.path",
      expected: "readable file",
      got: err?.code ?? "ENOENT",
      hint: `could not read source file: ${err?.message ?? err}`,
    });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "(document)",
      expected: "valid JSON",
      got: "parse error",
      hint: `JSON parse failed: ${err?.message ?? err}`,
    });
  }

  // Accept either { memories: [...] } or a top-level array
  const memories: RawClaudeMemory[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.memories)
      ? parsed.memories
      : [];

  if (!Array.isArray(parsed) && !Array.isArray(parsed?.memories)) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "(document)",
      expected: "{ memories: [...] } or top-level array",
      got: typeof parsed,
      hint: `unexpected shape — keys at root: ${Object.keys(parsed ?? {}).join(", ") || "none"}`,
    });
  }

  ctx.log.info("found memories", { count: memories.length });

  // Load project.json (optional) to derive subject and project name for foreignId
  let projectName = "unknown";
  try {
    const projectRaw = await fsp.readFile(join(sourceDir, "project.json"), "utf-8");
    const project = JSON.parse(projectRaw) as RawClaudeProject;
    projectName = project.name || "unknown";
  } catch {
    // project.json is optional; default to "unknown"
    ctx.log.debug("no project.json found, using default project name", { dir: sourceDir });
  }

  const subject = projectName !== "unknown" ? projectName : undefined;

  let kept = 0;
  let skipped = 0;
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const content =
      typeof m === "string" ? m
      : typeof m?.content === "string" ? m.content
      : typeof m?.text === "string" ? m.text
      : null;
    if (!content || content.trim() === "") {
      skipped++;
      continue;
    }
    kept++;
    yield {
      foreignId: typeof m?.id === "string"
        ? `claude-project:${projectName}:${m.id}`
        : `claude-project:${projectName}:idx-${i}`,
      content,
      subject,
      createdAt: typeof m?.created_at === "string" ? m.created_at : undefined,
      tags: ["source:claude-project", "import:claude-project"],
      durability: "persistent",
    };
  }

  ctx.log.info("import complete", { kept, skipped, project: projectName });
}

export const claudeProjectMemoryBridge: MemoryBridge = {
  name: "claude-project",
  version: 1,
  kind: "file",
  description: "Import a Claude project export (memory.json) into Flair",
  options: {
    source: {
      description: "Path to memory.json or to the Claude project export directory.",
      required: true,
    },
  },
  import: importClaudeProject,
  // No export — Claude's project store is closed; round-trip would have
  // nowhere useful to write back to.
};
