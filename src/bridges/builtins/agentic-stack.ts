/**
 * Built-in bridge: agentic-stack
 *
 * Imports lessons from agentic-stack's `.agent/memory/semantic/lessons.jsonl`
 * (and similar conventional paths) into Flair memories tagged
 * `source: "agentic-stack/lessons"`.
 *
 * The descriptor is an in-tree typed object rather than a YAML string —
 * built-ins ship inside the @tpsdev-ai/flair package and don't need the
 * YAML round-trip a user-authored descriptor goes through. The loader
 * for user descriptors (`yaml-loader.ts`) and this object both produce
 * a `YamlBridgeDescriptor`, so the runtime executor doesn't care which
 * source they came from.
 */

import type { YamlBridgeDescriptor } from "../types.js";

export const agenticStackDescriptor: YamlBridgeDescriptor = {
  name: "agentic-stack",
  version: 1,
  kind: "file",
  description: "Import agentic-stack `.agent/memory/semantic/lessons.jsonl` into Flair persistent memories",
  detect: {
    anyExists: [
      ".agent/AGENTS.md",
      ".agent/memory/semantic/lessons.jsonl",
    ],
  },
  import: {
    sources: [{
      path: ".agent/memory/semantic/lessons.jsonl",
      format: "jsonl",
      map: {
        content: "$.claim",
        subject: "$.topic",
        tags: "$.tags[*]",
        foreignId: "$.id",
        durability: "persistent",
        source: "agentic-stack/lessons",
      },
    }],
  },
};
