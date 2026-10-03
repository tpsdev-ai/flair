/**
 * durability-copy.ts — canonical durability copy for the CLI (flair#2217).
 *
 * The CLI is packaged separately from the server, so `src/` must not import
 * `resources/` (see src/cli.ts). These four statements are therefore a literal
 * copy of the server's resources/memory-durability.ts and the descriptor
 * package's packages/flair-tool-descriptors/src/index.ts; the documentation
 * contract test (test/unit/durability-doc-contract.test.ts) asserts all three
 * are byte-identical, so a selection point cannot drift.
 *
 * Every CLI option that lets a caller pick a durability reuses
 * `DURABILITY_TIERS_HELP` rather than restating the guarantee in its own words.
 */
export const DURABILITY_TIER_GUARANTEES: readonly string[] = [
  "permanent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier); it never decays and loads first in bootstrap.",
  "persistent — routine maintenance never reaps or age-archives it (a writer-set validTo still archives it, as for every tier).",
  "standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
];

/** The one-sentence limit every durability tier shares. */
export const DURABILITY_CAVEAT =
  "No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.";

/** Single-line form for a commander `--durability` option description. */
export const DURABILITY_TIERS_HELP =
  DURABILITY_TIER_GUARANTEES.join(" ") + " " + DURABILITY_CAVEAT;
