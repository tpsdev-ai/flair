/**
 * credential-status-rule.ts — the ONE Credential-usability rule, shared by the
 * CLI (src/) and the server (resources/).
 *
 * A `Credential(kind:"idp")` is the mapping that turns an IdP subject into a
 * flair principal. `resolveAgentFromSub` (resources/mcp-handler.ts) resolves a
 * token subject through it at request time, and `provisionIdpIdentityMapping`
 * (src/lib/mcp-enable.ts) is the layer that writes and maintains it. Before
 * this module both predicates accepted every status except `"revoked"`, so a
 * row with a missing, empty or unknown status was served as a live mapping, and
 * a revoked row fell through to JIT provisioning — which re-created the
 * principal the revocation was meant to stop. The XAA jwt-bearer grant
 * (resources/XAA.ts, `resolveOrCreatePrincipalLocked`) already accepts only
 * `"active"` (flair#2501); this module is that same allowlist, so the three
 * call sites cannot drift.
 *
 * The rule is an ALLOWLIST: a credential is usable only when its `status` is
 * exactly `"active"`. Missing, empty, `"revoked"` and any other value are not
 * usable.
 *
 * Deliberately dependency-free (it imports nothing): the resource/CLI boundary
 * guard (test/unit/resource-src-purity-1775.test.ts) requires every src/ module
 * a resources/ file imports to emit no module loads, and src/ must never import
 * harper.
 */

/** The only `status` value a Credential is usable with. */
export const CREDENTIAL_STATUS_ACTIVE = "active";

/**
 * Is `cred` a credential this rule accepts as usable? Exactly
 * `status === "active"`. A null/undefined credential, a missing status, an
 * empty string, `"revoked"` and any other value are all not usable.
 */
export function isUsableCredential(cred: { status?: unknown } | null | undefined): boolean {
  return cred?.status === CREDENTIAL_STATUS_ACTIVE;
}

/** How a refusal names the value it found: the stored status, or that none was there. */
function credentialStatusPhrase(status: unknown): string {
  return status === undefined || status === null ? "no status" : `status ${JSON.stringify(status)}`;
}

/**
 * The named refusal for a Credential whose status is not `"active"`: it names
 * the actor (the named credential — pass the surrounding subject too when the
 * caller has one), the state (the stored status, or that there is none) and the
 * remedy (an operator re-links the credential, which writes an active one).
 * Shared so the resolver and the linker refuse identically.
 */
export function credentialStatusRefusal(actor: string, status: unknown): string {
  return (
    `forbidden: ${actor} has ${credentialStatusPhrase(status)}; a Credential is usable only when its status is ` +
    `"active", so it was not used and nothing was written. An operator must re-link the credential ` +
    "(`flair mcp enable`, or `flair principal link`) to write an active mapping."
  );
}
