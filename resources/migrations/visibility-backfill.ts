/**
 * visibility-backfill.ts — backfills the `visibility` field on Memory rows
 * written before flair#509 (the durability-keyed default-visibility slice),
 * which never stamped `visibility` at all. riskClass 'derived-only':
 * `visibility` here is a derived stamp recomputable at any time from
 * `durability` (which remains on the row, untouched, forever) — never the
 * only copy of anything (invariant I) — and this migration only ever writes
 * into a field that is CURRENTLY EMPTY, so the cheapest posture applies:
 * metadata-only snapshot, no content-hash gate (row-count + stamp
 * convergence only, same as `embedding-stamp`/`graph-heal`).
 *
 * WHY THIS EXISTS: `resources/Memory.ts`'s `defaultVisibilityForDurability`
 * (flair#509) only stamps `visibility` on a WRITE — a row that has sat
 * untouched since before that slice shipped has no `visibility` field at
 * all. `src/cli.ts`'s federation push filter (`isFederationPrivateVisibility`)
 * excludes only `visibility === "private"` — by design, per
 * `resources/memory-visibility.ts`'s migration invariant, an ABSENT
 * `visibility` field is NOT private and must keep syncing exactly as
 * before (so today's single-org fleet never silently stops replicating
 * pre-#509 rows). That is correct while every federation peer IS this same
 * org's own fleet. A cross-organization hub pairing is coming, and at that
 * point an absent-visibility row that should have been private (a
 * `standard`/`ephemeral` note, never intended to leave the instance) would
 * cross an org boundary it never should. This migration closes that gap
 * proactively: once every row carries an explicit `visibility`, "absent"
 * becomes the empty set, and the existing filter (unchanged, zero new
 * behavior in it) is correct as-is for the cross-org case too.
 *
 * THE RULE (flair#509 — reused, not reinvented): `permanent`/`persistent`
 * durability -> `shared`; `standard`/`ephemeral` durability, OR durability
 * absent/unrecognised -> `private` (fail-safe: never widen access on a row
 * whose intent this migration cannot actually determine).
 * `deriveVisibilityFromDurability` below mirrors
 * `resources/Memory.ts`'s (unexported) `defaultVisibilityForDurability`
 * byte-for-byte. Deliberately DUPLICATED rather than imported: importing
 * `resources/Memory.ts` here would drag in its module-top-level
 * `export class Memory extends (databases as any).flair.Memory` — a class
 * EXTENDS that only resolves once a live Harper has already registered the
 * base `Memory` resource, which unit tests (no real Harper; see
 * `test/unit/migrations-visibility-backfill.test.ts`) cannot satisfy. Same
 * reasoning, same shape, as `src/cli.ts`'s `isFederationPrivateVisibility`
 * duplicating `resources/memory-visibility.ts`'s `isPrivateVisibility`
 * rather than importing it (see that file's comment) — both are one-line,
 * pure, and load-bearing enough that a comment pointing at the canonical
 * definition is the safer contract than a shared import with a landmine
 * behind it. If this rule ever changes, both copies must change together.
 *
 * NEVER OVERWRITES an existing `visibility` value — that is an explicit
 * author decision (their own call, even if it disagrees with what this
 * migration would have derived). Only rows where `visibility` is
 * null/undefined are eligible, and `run()` below re-verifies that on a
 * freshly-read record immediately before writing (the actual enforcement
 * of "never overwrite" — see the write-gate comment there), independent of
 * how precisely the candidate-selection query below narrowed things.
 *
 * THE CANDIDATE QUERY — why it looks different from `embedding-stamp`'s:
 * `visibility` is declared in `schemas/memory.graphql` but NOT `@indexed`
 * (unlike `embeddingModel`, which flair#807 needed indexed for its own
 * pending query). Every condition against it is therefore already a
 * full-table-scan filter (`resources/search.ts`'s `filterByType`), whether
 * or not the comparator is negated — the `not_equals`-forces-an-index-bypass
 * mechanism `embedding-stamp.ts` depends on (flair#807) is simply moot for
 * an attribute with no index to be stale in the first place. What DOES
 * still matter, and is the same lesson flair#807 taught: a strict-equals
 * filter (`recordValue === value`) never matches a row whose property was
 * NEVER SET (`recordValue` reads back as `undefined`, and `undefined !==
 * null`), so `{comparator: "equals", value: null}` alone would silently
 * miss every truly-absent row — exactly the rows this migration exists to
 * find. A NEGATED comparator does match them (`undefined !== "private"` is
 * true), so the pending condition here is `visibility not_equals "private"
 * AND visibility not_equals "shared"` — no separate `equals: null` leg
 * needed (unlike `embedding-stamp`, whose write path can leave an
 * intermediate explicit-null state on a failed HTTP regen; this migration's
 * write is a single in-process read-modify-write that either fully
 * succeeds or leaves the row in its exact prior state, so there is no
 * intermediate state to add a leg for). This exact `not_equal`-covers-
 * absent-and-null-and-nothing-else-with-the-value-itself semantics is
 * already relied on, in production, by `resources/memory-read-scope.ts`'s
 * cross-agent read-scope condition on this SAME field (`visibility !=
 * 'private'` — "which INCLUDES records missing the field entirely") — this
 * migration's query is not a new risk, it is the same proven mechanic.
 *
 * A garbage third value (something other than "private"/"shared"/absent)
 * would also match this AND-of-two-`not_equals` condition — Harper's query
 * algebra has no "attribute is absent" primitive to exclude that case at
 * the query level. No code path in this codebase ever writes such a value
 * today (confirmed by grep — every write site either omits `visibility`,
 * defaults it via `defaultVisibilityForDurability`, or passes an operator-
 * supplied string straight through with no allowlist, so nothing rules it
 * out categorically either). The write-gate in `run()` is what actually
 * protects against this, not the query: a row is only ever written to if a
 * freshly-read `.get()` shows `visibility` is STILL null/undefined at write
 * time. A genuinely garbage-valued row would be pulled in as a candidate,
 * re-checked, found to already carry an explicit (if unexpected) value, and
 * skipped — untouched, exactly like any other already-set row. Worst case
 * this makes `countPending()` overcount relative to what `run()` will ever
 * actually touch, which would show up as a real, visible completion-gate
 * halt (`resources/migrations/runner.ts`'s "completion gate failed:
 * rowsRemaining=N") rather than a silent skip or a false success — halt-
 * don't-brick (invariant II), and worth surfacing loudly if it ever
 * happens, since a garbage `visibility` value is itself a bug worth seeing.
 *
 * THE WRITE PATH — deliberately NOT `embedding-stamp`'s loopback-HTTP
 * `PUT /Memory/:id` trick. That mechanism exists ONLY because
 * `embedding-stamp` needs `resources/Memory.ts`'s SUBCLASS override (the
 * `content.content && !content.embedding` regen branch) to actually fire,
 * and the raw `databases.flair.Memory` reference (what this migration and
 * that one both get via their table accessor) resolves to the RAW
 * underlying table, silently skipping every subclass override — see that
 * file's module doc for the full, empirically-confirmed mechanism. This
 * migration needs NO subclass business logic (no dedup, no regen, no
 * provenance stamping, no rate limiting) — it is a narrow, single-field
 * patch, which is exactly the shape `resources/table-helpers.ts`'s
 * `patchRecord` documents and this codebase already uses directly against
 * the RAW table for the same kind of narrow metadata write:
 * `resources/auth-middleware.ts`'s `backfillEmbedding()` (patches
 * `embedding`), `resources/MemoryReflect.ts` and `resources/Memory.ts`
 * itself (both patch `lastReflected` this exact way). Per that file's own
 * warning, Harper's raw `.put()` is FULL RECORD REPLACEMENT — a partial
 * object silently deletes every field not included — so `run()` below
 * always spreads the freshly-read `existing` record before adding
 * `visibility`, the same read-modify-write shape `patchRecord` implements
 * (inlined here rather than calling that helper directly only because
 * `run()` already needs its own `.get()` for the write-gate check above,
 * and re-using that same read avoids a second, redundant round-trip).
 *
 * NO `recheckPending()`: that hook exists specifically to catch a stale
 * SECONDARY INDEX diverging from live values (flair#807, `embedding-stamp`
 * doc above) — a failure mode that requires an index to go stale in the
 * first place. `visibility` has no index at all (every read here is
 * already a live-record scan), so there is no analogous divergence for a
 * safety net to guard against. Same reasoning `graph-heal.ts` (also
 * `derived-only`, also unindexed-field-adjacent) already applies by also
 * omitting it.
 */
import { databases } from "harper";
import type { Migration, RunBatchResult } from "./types.js";

export type BackfilledVisibility = "private" | "shared";

export interface MemoryTableLike {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
  put(content: Record<string, unknown>): Promise<unknown>;
}

function defaultMemoryTable(): MemoryTableLike {
  return (databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory;
}

export const VISIBILITY_BACKFILL_ID = "visibility-backfill";

/**
 * flair#509's rule, reused verbatim (see module doc for why this is a
 * deliberate duplicate of `resources/Memory.ts`'s
 * `defaultVisibilityForDurability` rather than an import). Total function —
 * every input maps to exactly one of the two valid outputs, and the
 * fail-safe branch (`private`) is the ELSE of the allowlist check, so any
 * absent/null/unrecognised/wrong-typed `durability` value falls into it by
 * construction, never needs its own case.
 */
export function deriveVisibilityFromDurability(durability: unknown): BackfilledVisibility {
  return durability === "permanent" || durability === "persistent" ? "shared" : "private";
}

/**
 * Rows this migration still needs to touch: `visibility` is neither
 * "private" nor "shared" — see module doc for why this AND-of-two-
 * `not_equals` correctly matches both a truly-absent property and an
 * explicit `null`, without a separate `equals: null` leg.
 */
function pendingCondition() {
  return [
    { attribute: "visibility", comparator: "not_equals", value: "private" },
    { attribute: "visibility", comparator: "not_equals", value: "shared" },
  ];
}

/**
 * `getTable` is injectable so unit tests exercise this migration's full
 * detect/countPending/run logic against an in-memory fake table (matching
 * `embedding-stamp.ts`'s DI style) — no real Harper needed. Unlike
 * `embedding-stamp`, there is no separate HTTP mechanism to inject: the
 * write IS the table's own `.put()`, already covered by the same fake.
 */
export function createVisibilityBackfillMigration(getTable: () => MemoryTableLike = defaultMemoryTable): Migration {
  return {
    id: VISIBILITY_BACKFILL_ID,
    riskClass: "derived-only",
    affectsTables: ["Memory"],

    async detect(): Promise<boolean> {
      const table = getTable();
      for await (const _row of table.search({ conditions: pendingCondition(), limit: 1 })) {
        return true;
      }
      return false;
    },

    async countPending(): Promise<number> {
      const table = getTable();
      let n = 0;
      for await (const _row of table.search({ conditions: pendingCondition() })) n++;
      return n;
    },

    async run(batchSize: number): Promise<RunBatchResult> {
      const table = getTable();

      const candidates: Record<string, unknown>[] = [];
      for await (const row of table.search({ conditions: pendingCondition(), limit: batchSize })) {
        candidates.push(row);
      }

      const touchedIds: string[] = [];
      for (const row of candidates) {
        const id = String((row as { id?: unknown }).id ?? "");
        if (!id) continue;
        const existing = await table.get(id);
        if (!existing) continue; // deleted since the search above — nothing to fix

        // The write-gate: this is what actually enforces "never overwrite an
        // existing visibility value", independent of how precisely the
        // candidate query above narrowed things (see module doc — a
        // garbage third value would still be pulled in as a candidate).
        // Re-checks the FRESHLY-READ record, not the (possibly stale)
        // search-result row, and doubles as the idempotency/concurrent-
        // writer guard `embedding-stamp.ts` gets from its own analogous
        // pre-write check.
        if (existing.visibility !== undefined && existing.visibility !== null) continue;

        const derived = deriveVisibilityFromDurability(existing.durability);
        // Never-widen invariant, asserted, not just tested: the only two
        // values `deriveVisibilityFromDurability` can ever produce are
        // "private"/"shared" (see its own doc), so this can never fire
        // today — it exists to fail loudly (halting this migration via the
        // runner's mid-batch-throw path, never a silent bad write) if a
        // future edit to that function ever widens its return type or is
        // bypassed via a type-unsafe call.
        if (derived !== "private" && derived !== "shared") {
          throw new Error(
            `visibility-backfill: derived an invalid visibility for row ${id} — refusing to write`,
          );
        }

        await table.put({ ...existing, visibility: derived });
        touchedIds.push(id);
      }

      return { processed: touchedIds.length, touchedIds };
    },
  };
}
