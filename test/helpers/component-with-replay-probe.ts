/**
 * component-with-replay-probe.ts — flair#2061.
 *
 * Composes a PRIVATE copy of the built component with ONE added resource,
 * test/fixtures/replay-probe-2061/probe.js, installed as
 * `dist/resources/zz-replay-probe-2061.js` so the component's own
 * `jsResource` glob loads it on every Harper thread. The probe drives the
 * two-worker replay scenario over Harper's thread mesh and writes its results
 * under ROOTPATH (see the probe's header).
 *
 * FIXTURE-ONLY composition, the same shape as component-without-migration-boot:
 * nothing under resources/ or src/ changes or references the probe, and the
 * production tree gains no capability.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_SOURCE_REL = join("test", "fixtures", "replay-probe-2061", "probe.js");
export const PROBE_TARGET_REL = join("dist", "resources", "zz-replay-probe-2061.js");
/** Where the probe writes, relative to the instance's ROOTPATH. */
export const PROBE_OUT_REL = "replay-probe-2061";

export interface ProbeComponent {
  /** Pass as `startHarper({ cwd })`. */
  dir: string;
  /** Pass as `startHarper({ harperBinDir })`. */
  sourceRoot: string;
  cleanup: () => void;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function componentWithReplayProbe(opts: { sourceRoot?: string } = {}): ProbeComponent {
  const sourceRoot = opts.sourceRoot ?? repoRoot();
  if (!existsSync(join(sourceRoot, "dist", "resources", "agent-auth.js"))) {
    throw new Error(
      `componentWithReplayProbe: ${join(sourceRoot, "dist", "resources")} is not built — run \`bun run build\` first.`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "flair-replay-probe-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (existsSync(src)) cpSync(src, join(dir, entry), { recursive: true });
  }
  const nm = join(sourceRoot, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dir, "node_modules"), "dir");
  cpSync(join(repoRoot(), PROBE_SOURCE_REL), join(dir, PROBE_TARGET_REL));
  return {
    dir,
    sourceRoot,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
      } catch {
        /* best effort */
      }
    },
  };
}
