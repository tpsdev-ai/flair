/**
 * Built-in bridge: chatgpt
 *
 * Imports ChatGPT memories into Flair. ChatGPT's official data export
 * (Settings → Data Controls → Export My Data) contains conversations.json
 * and chat.html only — there is **no memories file**. ChatGPT memories live
 * exclusively in the Settings UI.
 *
 * The actual user workflow (per the Anthropic-published ChatGPT→Claude
 * migration guide) is:
 *   1. Run this prompt in ChatGPT:
 *        "Please share all the memories you have stored about me. List
 *        each memory as a separate bullet point, using plain language."
 *   2. Copy the resulting bulleted text block
 *   3. Paste into a .txt or .md file
 *   4. Run: flair bridge import chatgpt --source memories.txt --agent <id>
 *
 * Primary input: plain text file. One memory per line, optionally bullet-
 * prefixed (-, *, •, 1., 1)). Empty lines are skipped.
 *
 * Fallback input: JSON file containing { memories: [...] } or a top-level
 * array. This path supports third-party tool exports (e.g., browser
 * extensions that scrape memory UI into JSON) that follow that shape.
 *
 * Round-trip: one-way. ChatGPT's memory store is closed — no useful
 * destination for export.
 *
 * Usage:
 *   flair bridge import chatgpt --source memories.txt --agent <id>
 *   flair bridge import chatgpt --source memories.json --agent <id>  (third-party JSON)
 */

import { promises as fsp } from "node:fs";
import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

interface RawChatGPTMemory {
  id?: string;
  content?: string;
  text?: string;
  body?: string;
  created_at?: string;
}

// Strip common bullet/numbered-list prefixes from a line.
// Examples: "- foo" → "foo"; "* foo" → "foo"; "• foo" → "foo";
//   "1. foo" → "foo"; "1) foo" → "foo"; "  - foo" → "foo".
function stripBulletPrefix(line: string): string {
  const trimmed = line.trim();
  // Markdown bullets + unicode bullet
  const bulletMatch = trimmed.match(/^([-*•])\s+(.*)$/);
  if (bulletMatch) return bulletMatch[2];
  // Numbered list: "1. ", "1) ", "12. ", etc.
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

async function* importChatGPT(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  const { isAbsolute, resolve } = await import("node:path");
  const sourceArg = typeof opts.source === "string" ? opts.source : "";
  if (!sourceArg) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: "(unset)",
      field: "source",
      expected: "path to a .txt/.md/.json file containing your ChatGPT memories",
      got: "missing",
      hint: "pass --source <path>; example: flair bridge import chatgpt --source memories.txt --agent <id>",
    });
  }
  const filePath = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  // Stat first — directory inputs are not supported for chatgpt because
  // OpenAI's data export contains no memories file. Surface that explicitly
  // rather than silently failing on a missing memory.json.
  let isDir = false;
  try {
    const stat = await fsp.stat(filePath);
    isDir = stat.isDirectory();
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: filePath,
      field: "source",
      expected: "readable .txt/.md/.json file",
      got: err?.code ?? "ENOENT",
      hint: `could not resolve source: ${err?.message ?? err}`,
    });
  }
  if (isDir) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: filePath,
      field: "source",
      expected: "a file (not a directory)",
      got: "directory",
      hint: "OpenAI's ChatGPT export does not include a memories file — memories are UI-only. Run the extraction prompt in ChatGPT (\"List all memories you have about me as bullet points\"), paste the result into a .txt file, and pass that file as --source.",
    });
  }

  ctx.log.info("reading ChatGPT memory dump", { path: filePath });

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: filePath,
      field: "source.path",
      expected: "readable file",
      got: err?.code ?? "ENOENT",
      hint: `could not read source file: ${err?.message ?? err}`,
    });
  }

  // Detect input shape. Try JSON parse first; if it fails AND the file
  // doesn't have a .json extension, fall back to plain-text line parse.
  // This makes JSON the sticky path for users who clearly meant JSON
  // (so we don't silently treat broken JSON as 1-line "memories"), and
  // text the natural path for the migration-prompt workflow.
  const isJsonExt = /\.(json)$/i.test(filePath);

  let memories: Array<RawChatGPTMemory | string> = [];

  let parsed: any = null;
  let jsonParseErr: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    jsonParseErr = err;
  }

  if (parsed !== null) {
    // Parsed as JSON — accept { memories: [...] } or top-level array.
    if (Array.isArray(parsed)) {
      memories = parsed;
    } else if (Array.isArray(parsed?.memories)) {
      memories = parsed.memories;
    } else if (Array.isArray(parsed?.user_memory)) {
      memories = parsed.user_memory; // older third-party shape
    } else {
      throw new BridgeRuntimeError({
        bridge: "chatgpt",
        op: "import",
        path: filePath,
        field: "(document)",
        expected: "{ memories: [...] } or top-level array",
        got: typeof parsed,
        hint: `JSON parsed but shape is unexpected — keys at root: ${Object.keys(parsed ?? {}).join(", ") || "none"}. If you meant to pass a plain-text bullet list, save it as .txt instead of .json.`,
      });
    }
  } else if (isJsonExt) {
    // Extension says JSON but parse failed — surface that, don't silently fall back.
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
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

  let kept = 0;
  let skipped = 0;
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    // Lenient extract — try several common shapes.
    const content =
      typeof m === "string" ? m
      : typeof m?.content === "string" ? m.content
      : typeof m?.text === "string" ? m.text
      : typeof m?.body === "string" ? m.body
      : null;
    if (!content || content.trim() === "") {
      skipped++;
      continue;
    }
    kept++;
    const objM = typeof m === "object" && m !== null ? m as RawChatGPTMemory : null;
    yield {
      foreignId: typeof objM?.id === "string" ? `chatgpt:${objM.id}` : `chatgpt:idx-${i}`,
      content: content.trim(),
      createdAt: typeof objM?.created_at === "string" ? objM.created_at : undefined,
      tags: ["source:chatgpt", "import:chatgpt"],
      durability: "persistent",
    };
  }

  ctx.log.info("import complete", { kept, skipped });
}

export const chatgptMemoryBridge: MemoryBridge = {
  name: "chatgpt",
  version: 1,
  kind: "file",
  description: "Import ChatGPT memories (paste-the-prompt-output workflow) into Flair",
  options: {
    source: {
      description: "Path to a .txt/.md file with one memory per line/bullet, OR a .json file with { memories: [...] }.",
      required: true,
    },
  },
  import: importChatGPT,
  // No export — ChatGPT's memory store is closed; round-trip would have
  // nowhere useful to write back to.
};
