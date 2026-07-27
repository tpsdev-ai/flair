/**
 * data-dir.ts — resolves the directory the migration subsystem owns
 * (`<dataDir>/.migrations/{state.json,lock,snapshots,exports}`), and proves
 * it is actually usable BEFORE the boot cycle commits to it.
 *
 * ─── Why this file exists (flair#812) ──────────────────────────────────────
 * The previous resolution was a single expression, duplicated in
 * `resources/migration-boot.ts` and `resources/health.ts`:
 *
 *     process.env.HDB_ROOT ?? join(homedir(), ".flair", "data")
 *
 * Both halves of that were wrong in a way that only shows up off the
 * developer/default shape:
 *
 * 1. `HDB_ROOT` IS NEVER SET BY ANYTHING. It is not a Harper process env
 *    var — Harper's own root-path env var is `ROOTPATH`
 *    (`harper`'s `utility/common_utils.ts` reads
 *    `process.env['ROOTPATH']`; `HDB_ROOT` appears only as a legacy *config
 *    key* alias in `utility/hdbTerms.ts`, and Harper never reads or writes
 *    it on `process.env`). flair's own spawner (`src/cli.ts`) exports
 *    `ROOTPATH`, never `HDB_ROOT`, and `resources/models-dir.ts` already
 *    reads `ROOTPATH` for exactly this reason. So the `??` left branch was
 *    dead code and the effective resolution was UNCONDITIONALLY
 *    `~/.flair/data`, regardless of where Harper's real root actually is.
 *
 * 2. `~/.flair/data` is right only by coincidence — it is `flair init`'s
 *    default data dir, so on a default local install the two happen to
 *    coincide. On a PROVISIONED install (a service-managed spoke, a
 *    container, a Harper Fabric component deployment) the process's
 *    `homedir()` is whatever the service account has: possibly read-only,
 *    possibly nonexistent, and in general nothing to do with the instance's
 *    data.
 *
 * When `~/.flair/data` is not creatable, EVERY consumer of the old
 * expression failed — and, critically, failed SILENTLY: the very first
 * thing `runMigrationCycle` does is `acquireMigrationLock`, whose
 * `mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })` throws
 * `EACCES`/`ENOENT`, which the runner catches and turns into
 * `{ ran: false, reason: "lock error: ..." }` — a value `migration-boot.ts`
 * then discarded. No log line, no state file, no health signal, and every
 * migration ever shipped skipped forever on that instance. (Contrast
 * `resources/embeddings-boot.ts`, loaded by the SAME `jsResource` glob:
 * it touches no filesystem path of its own, which is exactly why embeddings
 * kept working on the affected shapes while migrations did not.)
 *
 * ─── The resolution ─────────────────────────────────────────────────────
 * An ordered candidate list, first USABLE one wins:
 *
 *   1. `FLAIR_MIGRATION_DATA_DIR` — explicit operator override. The escape
 *      hatch for any deployment shape whose data dir this module cannot
 *      infer; naming it in the failure message below is what makes an
 *      unresolvable instance actionable rather than merely reported.
 *   2. `HDB_ROOT` — retained purely for compatibility with anything that
 *      may have started setting it because flair once read it. Never set by
 *      Harper or by flair.
 *   3. `homedir()/.flair/data` — the historical default, and `flair init`'s
 *      own data dir. DELIBERATELY still ahead of `ROOTPATH`: on every
 *      currently-working install this is where the state file already
 *      lives, and reordering would silently relocate it (costing a
 *      re-detect pass and orphaning the existing audit record) on instances
 *      that have no problem at all. This fix is about instances where the
 *      cycle cannot run, not about relocating ones where it can.
 *   4. `ROOTPATH` — Harper's real root path. The rescue candidate: it is
 *      writable by definition on a running instance (Harper is writing its
 *      own databases there), so a shape whose `homedir()` is unusable still
 *      gets a stable, per-instance location instead of nothing.
 *   5. The Harper root INFERRED from this module's own location, but only
 *      when the running layout is unambiguously a deployed component (see
 *      `deployedComponentRootPath`). `ROOTPATH` is an env var, and a
 *      deployment that configures `rootPath` in Harper's config file
 *      instead of the environment leaves candidate 4 empty — this covers
 *      that case without guessing.
 *
 * "Usable" is probed by DOING THE REAL OPERATION the runner would do —
 * create `<dir>/.migrations` at 0700 and check it is writable — not by a
 * proxy check that could disagree with it. The probe is idempotent and, on
 * a healthy instance, is satisfied by the first candidate without touching
 * the others.
 *
 * If NO candidate is usable, `resolveWritableMigrationDataDir` returns
 * `dataDir: null` WITH the per-candidate reasons, and the boot path turns
 * that into a loud console error plus a `failed` progress entry per
 * registered migration — visible in `/HealthDetail`, `flair doctor` and
 * `flair quality`'s `instance.migrationsClean`. An instance that cannot run
 * migrations now says so; that silence was the actual defect.
 */
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit operator override for the migration data dir (see module doc). */
export const MIGRATION_DATA_DIR_ENV = "FLAIR_MIGRATION_DATA_DIR";

/** The subdirectory the migration subsystem owns inside whichever dataDir wins. */
export const MIGRATIONS_SUBDIR = ".migrations";

/**
 * Harper's root path, inferred from where THIS module is running, but ONLY
 * when the layout is unambiguously a deployed component:
 *
 *     <rootPath>/components/<name>/dist/resources/migrations/data-dir.js
 *
 * i.e. the directory two levels above `dist/` must itself be named
 * `components` — Harper's `componentsRoot` convention, and the layout
 * `deploy_component` produces. That check is what keeps this from firing on
 * a source checkout or an npm install, where the same arithmetic would
 * point at an arbitrary parent directory. Returns null whenever the layout
 * doesn't match, so a non-match contributes no candidate rather than a
 * guess.
 *
 * `moduleUrl` is a parameter purely so a unit test can exercise both the
 * matching and non-matching layouts without relocating the built file.
 */
export function deployedComponentRootPath(moduleUrl: string = import.meta.url): string | null {
  try {
    const here = dirname(fileURLToPath(moduleUrl)); // <component>/dist/resources/migrations
    const componentDir = dirname(dirname(dirname(here))); // <component>
    const componentsRoot = dirname(componentDir); // .../components
    if (basename(componentsRoot) !== "components") return null;
    return dirname(componentsRoot);
  } catch {
    return null;
  }
}

/**
 * Ordered candidates for the migration data dir. See the module doc for why
 * this order is what it is — in particular, why `homedir()/.flair/data`
 * stays ahead of `ROOTPATH`.
 */
export function migrationDataDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined): void => {
    const trimmed = p?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  add(env[MIGRATION_DATA_DIR_ENV]);
  add(env.HDB_ROOT);
  add(join(homedir(), ".flair", "data"));
  add(env.ROOTPATH);
  add(deployedComponentRootPath(moduleUrl));
  return out;
}

export interface DataDirProbe {
  dir: string;
  ok: boolean;
  /** errno-bearing message from the real mkdir/access attempt, when `ok` is false. */
  reason?: string;
}

/**
 * Probes a candidate by performing the exact operation the runner's lock
 * acquisition performs (`mkdir -p <dir>/.migrations` at 0700), then
 * confirming the result is writable. Idempotent: on an already-working
 * instance this is a no-op stat/mkdir against a directory that already
 * exists.
 */
export function probeMigrationDataDir(dir: string): DataDirProbe {
  const owned = join(dir, MIGRATIONS_SUBDIR);
  try {
    mkdirSync(owned, { recursive: true, mode: 0o700 });
    accessSync(owned, constants.W_OK | constants.X_OK);
    return { dir, ok: true };
  } catch (err) {
    return { dir, ok: false, reason: (err as Error)?.message ?? String(err) };
  }
}

export interface ResolvedMigrationDataDir {
  /** The first usable candidate, or null when every candidate failed. */
  dataDir: string | null;
  /** Every candidate probed, in order, with the failure reason for each rejection. */
  tried: DataDirProbe[];
}

/**
 * Resolves a migration data dir that is proven writable, or reports why not.
 * Used by the boot path (`resources/migration-boot.ts`), which must not
 * commit to a directory the runner will then fail to lock.
 */
export function resolveWritableMigrationDataDir(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMigrationDataDir {
  const tried: DataDirProbe[] = [];
  for (const candidate of migrationDataDirCandidates(env)) {
    const probe = probeMigrationDataDir(candidate);
    tried.push(probe);
    if (probe.ok) return { dataDir: candidate, tried };
  }
  return { dataDir: null, tried };
}

/**
 * Operator-facing explanation of a total resolution failure — carries the
 * actor (each path tried), the state (why each was rejected) and the remedy
 * (the override env var), so the message is actionable at 3am rather than
 * merely accurate.
 */
export function describeUnresolvableDataDir(tried: readonly DataDirProbe[]): string {
  const detail = tried.length
    ? tried.map((t) => `${t.dir} (${t.reason ?? "unusable"})`).join("; ")
    : "no candidate paths at all";
  return (
    `no writable migration data directory — tried ${detail}. ` +
    `Migrations cannot run on this instance until one exists: point ${MIGRATION_DATA_DIR_ENV} ` +
    `at a writable directory (or make one of the paths above writable by the account this ` +
    `instance runs as) and restart.`
  );
}

/**
 * READ-ONLY counterpart for `/HealthDetail`, which must never create
 * directories as a side effect of a GET. Prefers whichever candidate
 * already carries a `.migrations` directory (i.e. the one a boot actually
 * chose), falling back to the first candidate so the field is never empty.
 */
export function resolveMigrationDataDirForRead(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = migrationDataDirCandidates(env);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, MIGRATIONS_SUBDIR))) return candidate;
  }
  return candidates[0] ?? join(homedir(), ".flair", "data");
}
