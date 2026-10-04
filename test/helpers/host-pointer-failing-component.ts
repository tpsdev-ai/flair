/**
 * host-pointer-failing-component.ts — flair#1940 slice 1 (A1-iv item 6/7).
 *
 * Composes a PRIVATE copy of the built component whose pointer-table ADAPTER
 * (`dist/resources/host-pointer-adapter.js`) is REPLACED with one that throws
 * on every put/delete. This is the test-only build replacement the design
 * calls for: the production tree ships NO failure switch; only this composed
 * copy forces a pointer-write/delete failure, so a real-Harper integration test
 * can assert the rollback. Nothing under resources/ is changed.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one built resource the composed copy replaces (the pointer adapter). */
export const ADAPTER_REL = join("dist", "resources", "host-pointer-adapter.js");

export interface FailingComponent {
  dir: string;
  cleanup: () => void;
}

const FAILING_ADAPTER_JS = `// Test-only build replacement: every pointer-table write/delete throws.
// ESM, matching the package's "type": "module" - a CJS exports.* file would
// not be the module the loader imports, so the failure would never be injected.
export async function putPointerRow() { throw new Error("test adapter: forced host-pointer write failure"); }
export async function deletePointerRowViaTable() { throw new Error("test adapter: forced host-pointer delete failure"); }
`;

/** The exact ESM source the composed copy writes over the adapter, so a test
 *  can assert the composed file IS the failing adapter (a positive control). */
export const FAILING_ADAPTER_SRC = FAILING_ADAPTER_JS;

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function componentWithFailingHostPointer(opts: { sourceRoot?: string } = {}): FailingComponent {
  const sourceRoot = opts.sourceRoot ?? repoRoot();
  const sourceAdapter = join(sourceRoot, ADAPTER_REL);
  if (!existsSync(sourceAdapter)) {
    throw new Error(`componentWithFailingHostPointer: source adapter not found at ${sourceAdapter} — run \`bun run build\`.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "flair-failing-pointer-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  const nmSrc = join(sourceRoot, "node_modules");
  if (existsSync(nmSrc)) symlinkSync(nmSrc, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ADAPTER_REL), FAILING_ADAPTER_JS);
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}
