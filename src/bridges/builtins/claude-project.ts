/**
 * Built-in bridge: claude-project
 *
 * Imports Claude memories into Flair.
 *
 * Verified workflow (authoritative source — claude.com/import-memory,
 * verified 2026-05-10): Anthropic's published memory-import flow is
 * copy-paste only. The user runs an extraction prompt in Claude, copies
 * the result, and pastes it into Claude's memory settings (or, in our
 * case, into a local file we then import).
 *
 * Less-certain (third-party sources disagree, Anthropic's data-export
 * help article does not publish the file list): whether the standard
 * Claude data-export ZIP (Settings → Privacy → Export data) contains a
 * `memories.json` file. The bridge hedges by accepting either path:
 *   - Primary: the copy-paste workflow → user-staged .txt/.md/.json
 *   - Fallback: an extracted data-export directory whose memories file
 *     is named `memories.json` (auto-discovered alongside the user-staged
 *     names — see `findMemoryFileInDir` below)
 *
 * Primary input: plain text (.txt or .md) — bullet-prefixed or raw lines.
 * Fallback input: JSON containing `{ memories: [...] }` or top-level array.
 * Optional: a `project.json` file alongside supplying `{ name: "..." }`
 * to label the imported memories with a project subject + foreignId.
 *
 * Round-trip: one-way. Claude's memory store is closed.
 *
 * Usage:
 *   flair bridge import claude-project --source memory.txt --agent <id>
 *   flair bridge import claude-project --source memory.json --agent <id>
 *   flair bridge import claude-project --source ./claude-export --agent <id>
 *     (where ./claude-export contains memory.{txt,md,json} or memories.json,
 *      plus optional project.json)
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

function stripBulletPrefix(line: string): string {
  const trimmed = line.trim();
  const bulletMatch = trimmed.match(/^([-*•])\s+(.*)$/);
  if (bulletMatch) return bulletMatch[2];
  const numberedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
  if (numberedMatch) return numberedMatch[1];
  return trimmed;
}

function parsePlainText(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(stripBulletPrefix)
    .filter((line) => line.length > 0);
}

// Best-effort discovery of the "memory file" inside a directory source.
// Order:
//   1. memory.txt    — user-staged from the copy-paste workflow (most common)
//   2. memory.md     — user-staged markdown variant
//   3. memory.json   — user-staged JSON wrapper
//   4. memories.json — possible filename inside an Anthropic data-export
//                      ZIP. Anthropic's data-export help article doesn't
//                      publish the ZIP file list and third-party tools
//                      disagree on whether this file is present; including
//                      it here is a cheap hedge so the bridge handles either
//                      reality without a follow-up patch.
// Returns the first that exists, or null if none are present.
async function findMemoryFileInDir(dir: string): Promise<string | null> {
  for (const name of ["memory.txt", "memory.md", "memory.json", "memories.json"]) {
    const candidate = join(dir, name);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not present, continue
    }
  }
  return null;
}

async function* importClaudeProject(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  const { isAbsolute, resolve } = await import("node:path");
  const sourceArg = typeof opts.source === "string" ? opts.source : "";
  if (!sourceArg) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: "(unset)",
      field: "source",
      expected: "path to a .txt/.md/.json file (or directory containing one)",
      got: "missing",
      hint: "pass --source <path>; example: flair bridge import claude-project --source memory.txt --agent <id>",
    });
  }
  const sourceAbs = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  let filePath: string;
  let sourceDir: string;
  try {
    const stat = await fsp.stat(sourceAbs);
    if (stat.isDirectory()) {
      sourceDir = sourceAbs;
      const found = await findMemoryFileInDir(sourceAbs);
      if (!found) {
        throw new BridgeRuntimeError({
          bridge: "claude-project",
          op: "import",
          path: sourceAbs,
          field: "source",
          expected: "directory containing memory.txt, memory.md, or memory.json",
          got: "directory with no memory file",
          hint: "Claude's memory export is UI-only — copy your memory from Settings → Capabilities into memory.txt inside this directory, or pass the file path directly as --source.",
        });
      }
      filePath = found;
    } else {
      sourceDir = dirname(sourceAbs);
      filePath = sourceAbs;
    }
  } catch (err: any) {
    if (err instanceof BridgeRuntimeError) throw err;
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: sourceAbs,
      field: "source",
      expected: "readable file or directory",
      got: err?.code ?? "ENOENT",
      hint: `could not resolve source: ${err?.message ?? err}`,
    });
  }

  if (filePath.endsWith(".zip")) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "source",
      expected: "extracted file or directory",
      got: "zip archive",
      hint: `extract the .zip first, then point --source at the extracted directory or file:\n  unzip ${filePath} -d ./claude-export && flair bridge import claude-project --source ./claude-export --agent <id>`,
    });
  }

  ctx.log.info("reading Claude memory dump", { path: filePath });

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

  // Detect input shape. JSON path is sticky for .json extension; text path
  // for .txt/.md. For files without a recognized extension, try JSON first
  // and fall back to text on parse failure.
  const isJsonExt = /\.(json)$/i.test(filePath);

  let memories: Array<RawClaudeMemory | string> = [];

  let parsed: any = null;
  let jsonParseErr: any = null;
  if (isJsonExt) {
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      jsonParseErr = err;
    }
  } else {
    // For non-.json extensions, attempt JSON only as a fallback in case
    // the user named a JSON file with a wrong extension. Otherwise treat
    // as plain text.
    try {
      const candidate = JSON.parse(raw);
      if (Array.isArray(candidate) || (candidate && typeof candidate === "object" && (Array.isArray(candidate.memories) || Array.isArray((candidate as any).user_memory)))) {
        parsed = candidate;
      }
    } catch {
      // not JSON — fall through to plain-text path
    }
  }

  if (parsed !== null) {
    if (Array.isArray(parsed)) {
      memories = parsed;
    } else if (Array.isArray(parsed?.memories)) {
      memories = parsed.memories;
    } else {
      throw new BridgeRuntimeError({
        bridge: "claude-project",
        op: "import",
        path: filePath,
        field: "(document)",
        expected: "{ memories: [...] } or top-level array",
        got: typeof parsed,
        hint: `JSON parsed but shape is unexpected — keys at root: ${Object.keys(parsed ?? {}).join(", ") || "none"}. If you meant plain text, save as .txt instead of .json.`,
      });
    }
  } else if (isJsonExt) {
    throw new BridgeRuntimeError({
      bridge: "claude-project",
      op: "import",
      path: filePath,
      field: "(document)",
      expected: "valid JSON (file has .json extension)",
      got: "parse error",
      hint: `JSON parse failed: ${jsonParseErr?.message ?? jsonParseErr}. If you meant plain text, rename to .txt.`,
    });
  } else {
    // Plain-text path.
    memories = parsePlainText(raw);
  }

  ctx.log.info("found memories", { count: memories.length });

  // Load project.json (optional) to derive subject and project name for foreignId.
  let projectName = "unknown";
  try {
    const projectRaw = await fsp.readFile(join(sourceDir, "project.json"), "utf-8");
    const project = JSON.parse(projectRaw) as RawClaudeProject;
    projectName = project.name || "unknown";
  } catch {
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
    const objM = typeof m === "object" && m !== null ? m as RawClaudeMemory : null;
    yield {
      foreignId: typeof objM?.id === "string"
        ? `claude-project:${projectName}:${objM.id}`
        : `claude-project:${projectName}:idx-${i}`,
      content: content.trim(),
      subject,
      createdAt: typeof objM?.created_at === "string" ? objM.created_at : undefined,
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
  description: "Import Claude memory (Settings → Capabilities copy-paste workflow) into Flair",
  options: {
    source: {
      description: "Path to a .txt/.md file with one memory per line/bullet, OR a .json file with { memories: [...] }, OR a directory containing memory.{txt,md,json} (and optional project.json).",
      required: true,
    },
  },
  import: importClaudeProject,
  // No export — Claude's memory store is closed.
};
