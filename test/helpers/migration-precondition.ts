/**
 * migration-precondition.ts — the seed-only precondition for the
 * provisioned-datadir fixture (flair#812 case, flair#1785 slice 1).
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 * `test/integration/migrations-provisioned-datadir.test.ts` depends on an
 * invariant that the fixture only HALF asserts: that when boot 1 is stopped,
 * the seeded rows are the ONLY thing that has happened — boot 1's own
 * migration cycle has not run against the seed. The test checks the rows are
 * unstamped (`visibility == null`) BEFORE calling `stopHarper`, but that check
 * precedes shutdown, so it cannot establish the invariant: a boot-1 cycle that
 * runs between the null-check and boot 1's death would stamp those same rows
 * (and, worse, record its state under boot 1's data dir — the HOME candidate,
 * `<installDir>/.flair/data` — which the test then `rmSync`s).
 *
 * This guard inspects boot 1's migration state AFTER `stopHarper` has returned
 * and BEFORE that removal. If boot 1 recorded a `visibility-backfill` entry,
 * the seed-only precondition is not established and the fixture would prove
 * nothing: fail the test immediately, by name, in milliseconds — rather than
 * letting it fall through to a 60 s "no parseable state.json" timeout that
 * names the symptom two steps downstream of the cause (flair#1785).
 *
 * ─── What counts as "satisfied" ────────────────────────────────────────────
 *   - file absent            → satisfied. This is the EXPECTED state: boot 1's
 *                              cycle finds nothing pending at boot and the
 *                              runner writes no entry on the nothing-pending
 *                              path (`resources/migrations/runner.ts`).
 *   - present, no entry      → satisfied.
 *   - present WITH the entry → the precondition failure (named below).
 *   - present, unreadable or malformed → a SEPARATE inspection failure. Never
 *                              counted as absence: an unreadable state file is
 *                              "could not establish the precondition", not
 *                              "the precondition holds".
 *
 * The guard does not remove the race; it turns a contaminated precondition
 * into a fast, named failure (flair#1785 slice 1, deliverable B).
 */
import { existsSync, readFileSync } from "node:fs";

/** The migration id whose presence in boot 1's state means boot 1 executed the backfill. */
export const SEED_ONLY_ENTRY = "visibility-backfill";

export interface SeedOnlyPreconditionOptions {
  /** Boot 1's migration state path: `<installDir>/.flair/data/.migrations/state.json`. */
  statePath: string;
  /** The entry whose presence means boot 1 ran the migration. Default `visibility-backfill`. */
  entry?: string;
  /**
   * Milliseconds from the seed to boot 1's stop. Included in the failure text so
   * the window boot 1 had is part of the report, not something to reconstruct.
   */
  seedToStopMs?: number;
}

/** The named precondition failure (entry present). Exported so a test can assert the exact text. */
export function seedOnlyPreconditionMessage(statePath: string, entry: string, seedToStopMs?: number): string {
  const timing =
    seedToStopMs === undefined ? "" : ` Seed-to-stop window: ${seedToStopMs} ms.`;
  return (
    `Provisioned-datadir fixture: boot 1 left a ${entry} entry at ${statePath} before shutdown ` +
    `completed; the seed-only precondition is not established. Prevent migration execution during ` +
    `boot 1 and rerun; see flair#1785.${timing}`
  );
}

/** The named inspection failure (present but unreadable/malformed). */
export function seedOnlyInspectionMessage(statePath: string, err: unknown): string {
  const detail = (err as Error)?.message ?? String(err);
  return `Provisioned-datadir fixture: could not read boot 1's migration state at ${statePath}: ${detail}`;
}

/**
 * Asserts the seed-only precondition described in the module doc. Throws a
 * named error on either the precondition failure or an inspection failure;
 * returns silently when satisfied. Never treats an unreadable file as absence.
 */
export function assertSeedOnlyPrecondition(opts: SeedOnlyPreconditionOptions): void {
  const entry = opts.entry ?? SEED_ONLY_ENTRY;
  const { statePath } = opts;
  if (!existsSync(statePath)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch (err) {
    throw new Error(seedOnlyInspectionMessage(statePath, err));
  }
  // A file that PARSES but is not a JSON object (`null`, a number, an array) is
  // not a migration-state map either — inspect it, do not read it as absence.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(seedOnlyInspectionMessage(statePath, "parsed value is not a JSON object"));
  }
  const state = parsed as Record<string, unknown>;
  if (!state[entry]) return;

  throw new Error(seedOnlyPreconditionMessage(statePath, entry, opts.seedToStopMs));
}
