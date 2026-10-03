export const DURABILITY_TIER_GUARANTEES: readonly string[] = [
  "permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays and is considered before recent rows in bootstrap, subject to scope, expiry/closure and the token budget.",
  "persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it).",
  "standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.",
  "ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.",
];

/** The one-sentence limit every durability tier shares. */
export const DURABILITY_CAVEAT =
  "No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.";

/** Single-line form for a commander `--durability` option description. */
export const DURABILITY_TIERS_HELP =
  DURABILITY_TIER_GUARANTEES.join(" ") + " " + DURABILITY_CAVEAT;
