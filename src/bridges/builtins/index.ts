/**
 * Built-in bridge registry.
 *
 * Each built-in ships as either a `YamlBridgeDescriptor` (_shape A_: declarative YAML)
 * or a `MemoryBridge` (shape B: TypeScript code plugin). The CLI passes this
 * registry to `discover()` so built-ins surface in `flair bridge list` alongside
 * user-authored bridges, and to the import/export runtime so it knows how to
 * load the descriptor/plugin for a built-in name.
 *
 * To add a new built-in:
 *   - YAML: write `src/bridges/builtins/<name>.ts` exporting a `YamlBridgeDescriptor`
 *   - Code plugin: write `src/bridges/builtins/<name>.ts` exporting a `MemoryBridge`
 *   Then register it here. See specs/FLAIR-BRIDGES.md §2 for shapes A/B.
 */

import type {
  DiscoveredBridge,
  MemoryBridge,
  YamlBridgeDescriptor,
} from "../types.js";
import { agenticStackDescriptor } from "./agentic-stack.js";
import { markdownMemoryBridge } from "./markdown.js";

export interface BuiltinBridge {
  /** The discovery record surfaced in `flair bridge list`. */
  discovered: DiscoveredBridge;
  /** The runtime descriptor/plugin. */
  descriptorOrPlugin: YamlBridgeDescriptor | MemoryBridge;
}

function builtinDescriptor(d: YamlBridgeDescriptor): BuiltinBridge {
  return {
    discovered: {
      name: d.name,
      kind: d.kind,
      source: "builtin",
      path: `(builtin:${d.name})`,
      description: d.description,
      version: d.version,
    },
    descriptorOrPlugin: d,
  };
}

function builtinPlugin(p: MemoryBridge): BuiltinBridge {
  return {
    discovered: {
      name: p.name,
      kind: p.kind,
      source: "builtin",
      path: `(builtin:${p.name})`,
      description: p.description,
      version: p.version,
    },
    descriptorOrPlugin: p,
  };
}

/** All bridges shipped inside @tpsdev-ai/flair. Order doesn't matter. */
export const BUILTINS: BuiltinBridge[] = [
  builtinDescriptor(agenticStackDescriptor),
  builtinPlugin(markdownMemoryBridge),
];

/** Map name → descriptor/plugin for O(1) runtime lookup. */
export const BUILTIN_BY_NAME = new Map<string, BuiltinBridge>(
  BUILTINS.map((b) => [b.discovered.name, b]),
);

/** What `discover()` consumes for the `builtins` option. */
export function builtinDiscoveryRecords(): DiscoveredBridge[] {
  return BUILTINS.map((b) => b.discovered);
}
