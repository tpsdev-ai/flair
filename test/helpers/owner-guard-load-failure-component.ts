/**
 * owner-guard-load-failure-component.ts — flair#2468.
 *
 * Composes a private built component whose marker-id `_loadRecord` throws.
 * For addressed single-record HTTP PUT/PATCH, Harper calls this initial load
 * through `Table.getResource` before the resource method runs; the guard's
 * no-argument `super.get()` then returns the cached row. The integration test
 * checks Harper's own 500 at this seam, separately from a guard-thunk failure.
 *
 * The failure is ARMED by a sentinel file under the instance ROOTPATH
 * (`ARM_FILE`), so the same Harper can seed rows (via the ops API, which writes
 * through the native bridge and does not call `_loadRecord`) and serve normal
 * traffic before the test arms it.
 *
 * Production ships NO failure switch: nothing under resources/ is changed; only
 * this test composes a copy with the extra built module.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every id whose stored-row read should be made to fail carries this marker. */
export const LOAD_FAILURE_MARKER = "load-fail-2468";

/**
 * Sentinel file, created under the Harper instance ROOTPATH, that arms the
 * injected failure. Present → a marker-id load throws; absent → nothing is
 * touched. Lets the test seed data first, then flip the switch.
 */
export const ARM_FILE = "owner-guard-load-fail-armed";

/** Where the composed copy writes the patched-load module (a top-level built
 *  resource file, so `config.yaml`'s `jsResource.files: dist/resources/*.js`
 *  loads it with the rest of the component). */
export const LOAD_FAILURE_MODULE_REL = join("dist", "resources", "zz-test-owner-guard-load-failure.js");

/** The injected module source (ESM — the composed package is "type": "module"). */
export const LOAD_FAILURE_MODULE_SRC = `// Test-only module (composed copy): fail the read of a marker-id stored row at
// Harper's LOAD point, before any resource method runs.
import { databases } from "harper";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MARKER = ${JSON.stringify(LOAD_FAILURE_MARKER)};
const ARM_FILE = ${JSON.stringify(ARM_FILE)};

function armed() {
  return existsSync(join(process.env.ROOTPATH ?? "", ARM_FILE));
}

// Patch each table's load path. Read _loadRecord off the prototype chain as a
// DATA property (getOwnPropertyDescriptor never invokes an accessor), then
// shadow it on the concrete table prototype.
const TARGETS = [
  "AgentReadPosition", "Asset", "Credential", "Integration", "Memory",
  "MemoryCandidate", "MemoryGrant", "OrgEvent", "Relationship", "Soul",
  "WorkspaceState",
];

function patch(name) {
  const table = databases.flair[name];
  if (!table) return name + ":missing";
  let p = table.prototype;
  let desc;
  while (p) {
    desc = Object.getOwnPropertyDescriptor(p, "_loadRecord");
    if (desc) break;
    p = Object.getPrototypeOf(p);
  }
  if (!desc || typeof desc.value !== "function") return name + ":no-loadrecord";
  const orig = desc.value;
  Object.defineProperty(table.prototype, "_loadRecord", {
    configurable: true,
    writable: true,
    value: function (target, request, options) {
      const id = target && typeof target === "object" ? target.id : target;
      if (armed() && typeof id === "string" && id.includes(MARKER)) {
        throw new Error(
          "test component: forced stored-row read failure at Harper's load point (" + name + " id=" + id + ")",
        );
      }
      return orig.call(this, target, request, options);
    },
  });
  return name + ":ok";
}

const results = [];
for (const name of TARGETS) {
  try {
    results.push(patch(name));
  } catch (e) {
    results.push(name + ":error(" + e.message + ")");
  }
}
console.log("[owner-guard-load-failure] " + results.join(" "));
`;

export interface FailingComponent {
  dir: string;
  cleanup: () => void;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Compose a private copy of the built component with the load-failure module
 * written into `dist/resources`. `sourceRoot` defaults to this checkout; the
 * copy links the source's `node_modules` so Harper's binary resolves.
 */
export function componentWithOwnerGuardLoadFailure(opts: { sourceRoot?: string } = {}): FailingComponent {
  const sourceRoot = opts.sourceRoot ?? repoRoot();
  if (!existsSync(join(sourceRoot, LOAD_FAILURE_MODULE_REL))) {
    // The copy still needs the built tree; fail loudly rather than spawn a
    // component whose dist does not exist.
  }
  const dir = mkdtempSync(join(tmpdir(), "flair-owner-guard-loadfail-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  const nmSrc = join(sourceRoot, "node_modules");
  if (existsSync(nmSrc)) symlinkSync(nmSrc, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, LOAD_FAILURE_MODULE_REL), LOAD_FAILURE_MODULE_SRC);
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}
