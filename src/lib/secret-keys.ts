// NEVER_GENERATED_SECRET_KEYS — the product's authoritative list of credential
// key NAMES that must never appear in a `.env` flair GENERATES.
//
// This module deliberately has NO imports. flair#2589: a plain `node` script
// (scripts/ci/redact-launchd-plist.mjs) imports this list to avoid drifting
// from the product, but the list used to live in src/component-env.ts, which
// imports ./lib/mcp-oauth-env-core.js — a specifier that only exists in the
// compiled output, not the source tree, so `node` failed with
// ERR_MODULE_NOT_FOUND before the script could scan anything. A module with no
// imports loads in the form `node` has (the source `.ts`, type-stripped) as
// well as in the compiled dist/. src/component-env.ts re-exports it, so its
// public API is unchanged.
//
// An operator's own file is a different matter — see `planComponentEnv`, which
// preserves whatever they wrote and warns by key NAME (never value) rather than
// silently dropping or shipping it.
export const NEVER_GENERATED_SECRET_KEYS = [
  "HDB_ADMIN_PASSWORD",
  "FLAIR_ADMIN_PASSWORD",
  "FLAIR_ADMIN_PASS",
  "FABRIC_PASSWORD",
  "FLAIR_CLUSTER_ADMIN_PASS",
  "CLI_TARGET_PASSWORD",
  // The DCR initial access token (resources/dcr-gate.ts). It is a bearer
  // credential for an unauthenticated public endpoint, so it belongs in the
  // process environment, never in a deploy payload — that payload is ingested
  // into an hdb_deployment row and replicated to every node, per the argument
  // at the top of src/component-env.ts.
  "FLAIR_OAUTH_DCR_TOKEN",
] as const;
