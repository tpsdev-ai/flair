/**
 * component-without-migration-boot.ts — flair#1785 slice 2.
 *
 * Builds a PRIVATE copy of the built fixture component whose jsResource glob
 * (`dist/resources/*.js`, config.yaml) physically OMITS `migration-boot.js`.
 *
 * Why: `test/integration/migrations-provisioned-datadir.test.ts`'s boot 1 (the
 * seed phase) must be UNABLE to execute a migration cycle — initial or
 * follow-up — while it is seeding or shutting down. Scheduling is unconditional
 * and every successful cycle arms follow-ups (`resources/migration-boot.ts` →
 * `resources/migrations/recheck.ts`), so no timing stopwatch can establish that
 * invariant. Running boot 1 from a resource set that does not contain the
 * trigger does: the module's top-level `scheduleMigrationBoot()` never runs, so
 * the cycle is never scheduled.
 *
 * This is FIXTURE-ONLY composition. Nothing under src/ or resources/ is changed
 * and nothing references this module from there; production gains no capability
 * (see the bypass fixture and the import-graph check in the integration test).
 *
 * Import-graph finding: NO source module imports `migration-boot` (every
 * reference in resources/ is a comment; `scheduleMigrationBoot` /
 * `_resetMigrationBootForTests` have no importers outside the file itself). The
 * loader is the `jsResource` glob alone, so omitting the one built file severs
 * the scheduling entry with no stub and no product change.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one built resource the composed copy omits (the boot-cycle trigger). */
export const OMITTED_TRIGGER_REL = join("dist", "resources", "migration-boot.js");

export interface ComposedComponent {
  /** Pass as `startHarper({ cwd })` — the private component root. */
  dir: string;
  /** Where the ordinary component's trigger lives (the SOURCE, for assertions). */
  sourceRoot: string;
  /** The path the trigger WOULD occupy inside the copy (asserted absent). */
  omittedTriggerPath: string;
  /** Remove the copy from disk. Safe to call more than once. */
  cleanup: () => void;
}

function repoRoot(): string {
  // test/helpers/ → repo root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Materialise the composed component copy. Throws (loudly) if the source tree
 * is not built — a missing source trigger would make the copy meaningless.
 */
export function componentWithoutMigrationBoot(opts: { sourceRoot?: string } = {}): ComposedComponent {
  const sourceRoot = opts.sourceRoot ?? repoRoot();
  const sourceTrigger = join(sourceRoot, OMITTED_TRIGGER_REL);
  if (!existsSync(sourceTrigger)) {
    throw new Error(
      `componentWithoutMigrationBoot: source trigger not found at ${sourceTrigger} — ` +
        `the tree is not built (run \`bun run build\`). An unbuilt tree cannot prove anything about composition.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "flair-composed-"));
  // Everything the jsResource/schema/env globs read from the component root,
  // except the one file we deliberately omit.
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  // Node resolution for the component's own imports (harper, js-yaml, …). A
  // symlink keeps the copy small and cannot alter which trigger file is loaded
  // — that is decided by the glob over dist/resources, not by node_modules.
  const nmSrc = join(sourceRoot, "node_modules");
  if (existsSync(nmSrc)) symlinkSync(nmSrc, join(dir, "node_modules"), "dir");

  const omittedTriggerPath = join(dir, OMITTED_TRIGGER_REL);
  rmSync(omittedTriggerPath, { force: true });
  if (existsSync(omittedTriggerPath)) {
    throw new Error(`componentWithoutMigrationBoot: failed to omit ${omittedTriggerPath}`);
  }

  return {
    dir,
    sourceRoot,
    omittedTriggerPath,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}
