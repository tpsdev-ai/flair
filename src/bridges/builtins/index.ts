/**
 * Built-in bridge registry.
 *
 * Each built-in ships as a typed `YamlBridgeDescriptor` (see
 * `agentic-stack.ts`). The CLI passes this registry to `discover()` so
 * built-ins surface in `flair bridge list` alongside user-authored
 * bridges, and to the import/export runtime so it knows how to load
 * the descriptor for a built-in name.
 *
 * To add a new built-in: write `src/bridges/builtins/<name>.ts`
 * exporting a `YamlBridgeDescriptor`, then register it here.
 */

import type {
  DiscoveredBridge,
  YamlBridgeDescriptor,
} from "../types.js";
import { agenticStackDescriptor } from "./agentic-stack.js";

export interface BuiltinBridge {
  /** The discovery record surfaced in `flair bridge list`. */
  discovered: DiscoveredBridge;
  /** The full descriptor used by the runtime. */
  descriptor: YamlBridgeDescriptor;
}

function builtin(d: YamlBridgeDescriptor): BuiltinBridge {
  return {
    discovered: {
      name: d.name,
      kind: d.kind,
      source: "builtin",
      path: `(builtin:${d.name})`,
      description: d.description,
      version: d.version,
    },
    descriptor: d,
  };
}

/** All bridges shipped inside @tpsdev-ai/flair. Order doesn't matter. */
export const BUILTINS: BuiltinBridge[] = [
  builtin(agenticStackDescriptor),
];

/** Map name → descriptor for O(1) runtime lookup. */
export const BUILTIN_BY_NAME = new Map<string, BuiltinBridge>(
  BUILTINS.map((b) => [b.discovered.name, b]),
);

/** What `discover()` consumes for the `builtins` option. */
export function builtinDiscoveryRecords(): DiscoveredBridge[] {
  return BUILTINS.map((b) => b.discovered);
}
