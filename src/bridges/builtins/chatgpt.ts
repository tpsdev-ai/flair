/**
 * Built-in bridge: chatgpt
 *
 * Imports a ChatGPT memory dump into Flair memories. The path that ships in
 * v1 is the file-export shape — when a user requests their ChatGPT data
 * archive, the export contains a `memory.json` (or older exports may have
 * memory inlined into `user.json`). Each memory in the dump becomes one
 * Flair memory tagged `source: "chatgpt/memory"`.
 *
 * Round-trip: this is a one-way import. ChatGPT's memory store is closed,
 * so the export side is omitted (it'd have nowhere useful to write to).
 *
 * Why a Shape B (code) bridge and not Shape A (YAML descriptor):
 * - The OpenAI export wraps memories under `{ memories: [...] }`. The Shape A
 *   JSON parser treats the whole document as one record (it doesn't traverse
 *   nested paths). A code plugin can unwrap cleanly.
 * - We're lenient about field names — `content` first, then `text`, then
 *   `body`, then bare-string. Easier to express in TS than in a YAML
 *   fallback chain.
 *
 * Source shapes accepted:
 *   1. A directory containing `memory.json` (the OpenAI export root)
 *   2. A direct path to `memory.json`
 *   3. The wrapper `{ memories: [...] }` OR a top-level array
 *
 * Usage:
 *   flair bridge import chatgpt --cwd ./openai-export --agent <id>
 *   flair bridge import chatgpt --cwd ./openai-export --agent <id> --dry-run
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { BridgeContext, BridgeMemory, MemoryBridge } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

interface RawChatGPTMemory {
  id?: string;
  content?: string;
  text?: string;
  body?: string;
  created_at?: string;
}

async function* importChatGPT(
  opts: Record<string, unknown>,
  ctx: BridgeContext,
): AsyncIterable<BridgeMemory> {
  // Resolve source. Caller passes `--source <path>` pointing at either
  // the memory.json file directly OR the OpenAI export directory containing
  // it. Absolute paths win; relative paths resolve against process.cwd
  // (matching the markdown bridge's convention — BridgeContext doesn't
  // carry a cwd field as of v1).
  const { isAbsolute, resolve } = await import("node:path");
  const sourceArg = typeof opts.source === "string" ? opts.source : "";
  if (!sourceArg) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: "(unset)",
      field: "source",
      expected: "path to memory.json or to the OpenAI export directory",
      got: "missing",
      hint: "pass --source <path>; example: flair bridge import chatgpt --source ./openai-export --agent <id>",
    });
  }
  const sourceAbs = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  let filePath: string;
  try {
    const stat = await fsp.stat(sourceAbs);
    filePath = stat.isDirectory() ? join(sourceAbs, "memory.json") : sourceAbs;
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: sourceAbs,
      field: "source",
      expected: "readable file or directory containing memory.json",
      got: err?.code ?? "ENOENT",
      hint: `could not resolve source: ${err?.message ?? err}`,
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

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: filePath,
      field: "(document)",
      expected: "valid JSON",
      got: "parse error",
      hint: `JSON parse failed: ${err?.message ?? err}`,
    });
  }

  // Accept either { memories: [...] } or a top-level array. Anything else
  // is unexpected; surface a helpful error rather than silently importing 0.
  const memories: RawChatGPTMemory[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.memories)
      ? parsed.memories
      : Array.isArray(parsed?.user_memory) // older exports occasionally use this
        ? parsed.user_memory
        : [];

  if (!Array.isArray(parsed) && !Array.isArray(parsed?.memories) && !Array.isArray(parsed?.user_memory)) {
    throw new BridgeRuntimeError({
      bridge: "chatgpt",
      op: "import",
      path: filePath,
      field: "(document)",
      expected: "{ memories: [...] } or top-level array",
      got: typeof parsed,
      hint: `unexpected shape — keys at root: ${Object.keys(parsed ?? {}).join(", ") || "none"}`,
    });
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
    yield {
      foreignId: typeof m?.id === "string" ? `chatgpt:${m.id}` : `chatgpt:idx-${i}`,
      content,
      createdAt: typeof m?.created_at === "string" ? m.created_at : undefined,
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
  description: "Import a ChatGPT memory dump (memory.json from an OpenAI data export) into Flair",
  options: {
    source: {
      description: "Path to memory.json (or to the OpenAI-export directory containing it).",
      required: true,
    },
  },
  import: importChatGPT,
  // No export — ChatGPT's memory store is closed; round-trip would have
  // nowhere useful to write back to.
};
