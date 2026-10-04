/**
 * engine-version-stamp-boot.ts — writes the engine-version stamp
 * (`<dataDir>/engine-version.txt`) at boot, so a data directory written by
 * THIS release's Harper engine is refused by an older flair's backwards-engine
 * guard (flair#1047 / flair#905) BEFORE that older engine opens the store.
 *
 * ─── Why a boot module and not just the CLI ────────────────────────────────
 * `src/cli.ts`'s `stampEngineVersionIfRunning` writes the stamp after a
 * successful `flair start`/`restart`. That covers boots the CLI drives, but
 * a store can also be written by a Harper process the CLI did not spawn
 * (a component deployment, or any direct `harper run`), and the stamp is a
 * property of the ENGINE that wrote the store, not of the process that
 * happened to launch it. Writing it from the component's own boot — the
 * same `jsResource` load every other boot module here uses
 * (migration-boot.ts, flair-agent-role-boot.ts) — makes "a store written by
 * this engine carries this engine's version" true regardless of the door.
 *
 * ─── What the published guard reads ────────────────────────────────────────
 * The published flair's `guardEngineNotBackwards` reads
 * `readInstalledHarperVersion(flairPackageDir())` for the RUNNING engine and
 * `readEngineVersionStamp(dataDir)` for the writer, where `dataDir` is
 * `flairDataDir()` = `~/`.flair`/data` (HOME-based). So the stamp this module
 * writes is placed in that SAME HOME-based directory, and only when it already
 * exists — a real flair data dir, never a directory this module creates. On a
 * layout where HOME's `.flair/data` is not the store (a Harper root that only
 * ROOTPATH names), this module writes nothing; the guard reads nothing there
 * either, so the two stay consistent.
 *
 * Best-effort, like the CLI's stamp: a failed write must never take down the
 * server, and there is nothing here for an operator to configure.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readInstalledHarperVersion, writeEngineVersionStamp } from "../src/engine-version.js";
import { flairDataDir } from "../src/lib/flair-paths.js";

/** The flair package root (`<pkg>/dist/resources/x.js` → `<pkg>`). */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Write the running engine's version stamp into this instance's data dir. */
export function stampEngineVersionOnBoot(dataDir: string = flairDataDir()): void {
  try {
    if (!existsSync(dataDir)) return;
    const version = readInstalledHarperVersion(packageRoot());
    if (version) writeEngineVersionStamp(dataDir, version);
  } catch {
    // Best-effort: a stamp write is never allowed to fail a boot.
  }
}

stampEngineVersionOnBoot();
