/**
 * Unified descriptor loader.
 *
 * Given a discovered bridge, resolve it into a `YamlBridgeDescriptor`
 * that the runtime executor can drive — regardless of whether the
 * descriptor came from the in-tree built-in registry, a project-local
 * YAML, a user-scoped YAML, or an npm package.
 *
 * Code-plugin bridges (Shape B, npm packages) are not supported in
 * slice 2 — calling `loadDescriptor` on one returns a structured error
 * pointing at slice 3.
 */

import type { DiscoveredBridge, YamlBridgeDescriptor } from "../types.js";
import { BridgeRuntimeError } from "../types.js";
import { loadYamlDescriptor } from "./yaml-loader.js";
import { BUILTIN_BY_NAME } from "../builtins/index.js";

export async function loadDescriptor(
  discovered: DiscoveredBridge,
): Promise<YamlBridgeDescriptor> {
  switch (discovered.source) {
    case "builtin": {
      const builtin = BUILTIN_BY_NAME.get(discovered.name);
      if (!builtin) {
        throw new BridgeRuntimeError({
          bridge: discovered.name,
          op: "import",
          field: "(builtin)",
          expected: `registered built-in name`,
          got: discovered.name,
          hint: `discovery surfaced built-in "${discovered.name}" but the registry has no entry — likely a code drift between discover.ts and builtins/index.ts`,
        });
      }
      return builtin.descriptor;
    }
    case "project-yaml":
    case "user-yaml":
      return await loadYamlDescriptor(discovered.path);
    case "npm-package":
      throw new BridgeRuntimeError({
        bridge: discovered.name,
        op: "import",
        path: discovered.path,
        field: "(kind)",
        expected: "yaml file or built-in",
        got: "npm code plugin",
        hint: "code-plugin bridge runtime ships in slice 3 of FLAIR-BRIDGES (alongside the `flair bridge allow` trust prompt). Use a YAML descriptor in the meantime, or wait for slice 3.",
      });
  }
}
