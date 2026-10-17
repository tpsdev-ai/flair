/**
 * memory-route-registry.ts — a stand-in for Harper's live route registry
 * (`server.resources`) for unit tests that mock `harper` and need the
 * middleware's Harper-routed path. `getMatch` answers for one registered
 * `Memory` resource the way Harper's `Resources.getMatch` does: a `Memory`
 * prefix followed by `/`, `?` or the end, then the file-type-suffix fallback
 * (`Memory.<ext>...` routes to `Memory` with only the query left). The entry's
 * resource uses Harper's own `Resource.parsePath` over the declared Memory
 * attributes, and `HarperRequestTarget` is Harper's own `RequestTarget`, both
 * loaded from the installed package.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DECLARED_MEMORY_ATTRIBUTES } from "../../resources/memory-declared-attributes.ts";

// Harper's package `exports` map hides its internal modules, so load the
// compiled files by the package root (as routed-target-parser-parity does).
const req = createRequire(import.meta.url);
const harperDist = join(dirname(req.resolve("harper/package.json")), "dist", "resources");
export const HarperRequestTarget: new (target: string) => any = req(join(harperDist, "RequestTarget.js")).RequestTarget;
const { Resource } = req(join(harperDist, "Resource.js"));

const MemoryResource = {
  attributes: (DECLARED_MEMORY_ATTRIBUTES as readonly string[]).map((name) => ({ name })),
  parsePath: Resource.parsePath,
};

export function memoryRouteRegistry(): { getMatch: (url: string, exportType?: string) => any } {
  return {
    getMatch(url: string) {
      const next = url.charAt("Memory".length);
      if (url.startsWith("Memory") && (next === "" || next === "/" || next === "?")) {
        return { path: "Memory", relativeURL: url.slice("Memory".length), Resource: MemoryResource };
      }
      const q = url.indexOf("?");
      const path = q === -1 ? url : url.slice(0, q);
      if (path.split(".")[0] === "Memory") {
        return { path: "Memory", relativeURL: q === -1 ? "" : url.slice(q), Resource: MemoryResource };
      }
      return undefined;
    },
  };
}
