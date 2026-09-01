/**
 * upgrade-migrations.ts — flair#1439
 *
 * Version-keyed migrations that `flair upgrade` applies automatically during
 * the post-restart verification step. These are distinct from the Harper data
 * migrations in `resources/migrations/`: those run inside the server and
 * transform stored data. These run in the CLI and bring the LOCAL dev-env
 * (hook files, config snippets) up to the state a fresh `flair init` would
 * produce for the harnesses already wired on this machine.
 *
 * ## Consent model
 *
 * A migration runs when ALL of the following hold:
 *   1. The installed harness/artifact is ALREADY present on this machine
 *      (the user consented to that integration when they ran `flair init`).
 *   2. The target version (`toVersion`) introduces the artifact for the first
 *      time (`toAtLeast`), AND the previous version did not have it
 *      (`fromBefore`).
 *   3. The artifact is currently absent (idempotent: nothing to do if it's
 *      already there).
 *
 * Because (1) is the consent gate, no extra flag or TTY interaction is
 * required. The user already said "wire Codex" — the migration just applies
 * the piece their old init couldn't know about.
 *
 * ## Adding a new migration
 *
 *   1. Push a new entry onto UPGRADE_MIGRATIONS.
 *   2. Set `fromBefore` to the first version that includes the new artifact.
 *   3. Set `toAtLeast` to the same version.
 *   4. Implement `apply(ctx)` — return ok:false (surfaced as a warning) on
 *      partial failure; throw only on hard failure that should be logged.
 *
 * Migrations run in order; later entries may assume earlier ones completed.
 */


import {
  installHook,
  hookSettingsPath,
  SUPPORTED_HARNESSES,
  type Harness,
} from "../hook-install.js";
import { checkSessionStartHook, readClientMcpBlock } from "../doctor-client.js";
import { parseSemverCore } from "../fabric-upgrade.js";

// ─── Semver helpers ───────────────────────────────────────────────────────────

/** True if version `a` is strictly less than `b`. */
function semverLt(a: string, b: string): boolean {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return false;
  if (pa[0] !== pb[0]) return pa[0] < pb[0];
  if (pa[1] !== pb[1]) return pa[1] < pb[1];
  return pa[2] < pb[2];
}

/** True if version `a` is greater than or equal to `b`. */
function semverGte(a: string, b: string): boolean {
  return !semverLt(a, b);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpgradeMigrationContext {
  /** Absolute path to the user's home directory. */
  homeDir: string;
  /** Port the upgraded instance is listening on. */
  port: number;
  /**
   * IDs of MCP clients currently detected on this machine (e.g. ["codex"]).
   * Provided by the caller so tests can inject without touching the filesystem.
   */
  detectedClientIds: readonly string[];
}

export interface UpgradeMigrationResult {
  /** Machine-readable id matching the migration's `id`. */
  id: string;
  /** Human-readable one-line summary of what happened. */
  message: string;
  /** True if the migration applied successfully (or was a no-op). */
  ok: boolean;
  /**
   * True if a write actually happened (ok=true AND something changed on disk).
   * False for no-ops (artifact was already present) and for failures.
   */
  wrote: boolean;
}

export interface UpgradeMigration {
  /** Stable id — used in tests and logs. */
  id: string;
  /** Human-readable description for logs. */
  description: string;
  /**
   * The first version that introduced this artifact.
   * Migration applies when: fromVersion < fromBefore AND toVersion >= toAtLeast.
   */
  fromBefore: string;
  /** Same as fromBefore in the normal case. */
  toAtLeast: string;
  /** Apply the migration. Return ok:false to surface a non-fatal warning. */
  apply(ctx: UpgradeMigrationContext): UpgradeMigrationResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine if a harness is "already wired" — the user previously ran
 * `flair init` for it and the MCP block (config.toml / mcpServers JSON) is
 * present. The hook itself is what we're migrating IN, so we deliberately
 * do NOT check for the hook's presence here.
 *
 * Uses readClientMcpBlock (which temporarily overrides HOME) so the homeDir
 * arg is honoured correctly in tests.
 */
function isHarnessWired(homeDir: string, harness: Harness): boolean {
  const clientId = harness === "codex" ? "codex" : "claude-code";
  const block = readClientMcpBlock(clientId, homeDir);
  return block.present;
}

/**
 * Install the SessionStart hook for a harness, reading the agent id and flair
 * URL from the existing MCP block (same as `resolveUpgradeHookInstall` in
 * doctor-run.ts, but self-contained to avoid a circular dep).
 */
function applySessionStartHookForHarness(
  homeDir: string,
  harness: Harness,
  port: number,
): UpgradeMigrationResult {
  const id = `session-start-hook@0.50.0/${harness}`;

  // Already present → idempotent no-op.
  const settingsPath = hookSettingsPath(homeDir, harness);
  const existing = checkSessionStartHook(homeDir, settingsPath);
  if (existing.present) {
    return { id, message: `SessionStart hook (${harness}): already present — no-op`, ok: true, wrote: false };
  }

  // Not wired at all → skip (don't wire a harness the user never had).
  if (!isHarnessWired(homeDir, harness)) {
    return { id, message: `SessionStart hook (${harness}): harness not wired — skip`, ok: true, wrote: false };
  }

  // Resolve agentId + flairUrl from the existing MCP block.
  const clientId = harness === "codex" ? "codex" : "claude-code";
  const block = readClientMcpBlock(clientId, homeDir);
  const agentId =
    (typeof process.env.FLAIR_AGENT_ID === "string" && process.env.FLAIR_AGENT_ID) ||
    block.agentId;
  const flairUrl =
    (typeof process.env.FLAIR_URL === "string" && process.env.FLAIR_URL) ||
    block.flairUrl ||
    `http://127.0.0.1:${port}`;

  if (!agentId) {
    return {
      id,
      message: `SessionStart hook (${harness}): no agent id found in MCP config — run: flair hook install --harness ${harness}`,
      ok: false,
      wrote: false,
    };
  }

  const result = installHook({ homeDir, harness, agentId, flairUrl });
  return {
    id,
    message: result.message,
    ok: result.ok,
    wrote: result.ok,
  };
}

// ─── Migration registry ───────────────────────────────────────────────────────

/**
 * Ordered list of all CLI upgrade migrations.
 *
 * To add a migration: push a new entry, set fromBefore/toAtLeast, implement
 * apply(). The runner calls apply() only when the version window matches.
 */
export const UPGRADE_MIGRATIONS: readonly UpgradeMigration[] = [
  {
    id: "session-start-hook@0.50.0",
    description: "Install missing SessionStart hook(s) for harnesses already wired in a pre-0.50.0 init",
    fromBefore: "0.50.0",
    toAtLeast: "0.50.0",
    apply(ctx: UpgradeMigrationContext): UpgradeMigrationResult[] {
      // Only act on detected hook-capable harnesses already wired on this machine.
      const harnesses = SUPPORTED_HARNESSES.filter(
        (h) => ctx.detectedClientIds.includes(h) && isHarnessWired(ctx.homeDir, h),
      );
      if (harnesses.length === 0) return [];
      return harnesses.map((h) => applySessionStartHookForHarness(ctx.homeDir, h, ctx.port));
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface ApplyUpgradeMigrationsResult {
  /** One entry per migration that was in-scope (may be empty). */
  applied: { migration: UpgradeMigration; results: UpgradeMigrationResult[] }[];
  /** True if every in-scope migration completed without any ok:false results. */
  allOk: boolean;
}

/**
 * Run all CLI upgrade migrations whose version window matches
 * `fromVersion → toVersion`. Migrations whose window is not matched are
 * silently skipped (they're not pending for this upgrade pair).
 *
 * @param fromVersion  The previously installed version (null → unknown, skip
 *                     migrations that need a version gate).
 * @param toVersion    The newly installed version (null → unknown, skip all).
 * @param ctx          Runtime context (homeDir, port, detectedClientIds).
 */
export function applyUpgradeMigrations(
  fromVersion: string | null,
  toVersion: string | null,
  ctx: UpgradeMigrationContext,
  // Injectable for tests (e.g. the throwing-migration case); production callers
  // use the real registry.
  migrations: readonly UpgradeMigration[] = UPGRADE_MIGRATIONS,
): ApplyUpgradeMigrationsResult {
  const applied: { migration: UpgradeMigration; results: UpgradeMigrationResult[] }[] = [];

  if (!fromVersion || !toVersion) {
    // Cannot gate on version — skip all version-keyed migrations.
    return { applied, allOk: true };
  }

  for (const migration of migrations) {
    const pending =
      semverLt(fromVersion, migration.fromBefore) &&
      semverGte(toVersion, migration.toAtLeast);
    if (!pending) continue;

    // A migration must never CRASH the upgrade: a thrown apply() is strictly
    // worse than the pre-migration doctor failure it was meant to prevent — no
    // summary, partial writes, and the doctor catalog never runs. Catch it,
    // surface it as a non-fatal ok:false result, and let the catalog proceed
    // (flair#1439, per Kern review).
    let results: UpgradeMigrationResult[];
    try {
      results = migration.apply(ctx);
    } catch (err) {
      results = [{
        id: migration.id,
        message: `${migration.id}: migration failed (${err instanceof Error ? err.message : String(err)}) — run \`flair doctor\` to check the current state`,
        ok: false,
        wrote: false,
      }];
    }
    if (results.length > 0) {
      applied.push({ migration, results });
    }
  }

  const allOk = applied.every((a) => a.results.every((r) => r.ok));
  return { applied, allOk };
}
