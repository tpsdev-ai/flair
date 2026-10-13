/**
 * credential-status-rule.ts — the Credential-usability rule shared by the MCP
 * credential resolver, the principal linker and the XAA jwt-bearer grant, from
 * both the CLI (src/) and the server (resources/).
 *
 * A `Credential(kind:"idp")` is the mapping that turns an IdP subject into a
 * flair principal. `resolveAgentFromSub` (resources/mcp-handler.ts) resolves a
 * token subject through it at request time, `provisionIdpIdentityMapping`
 * (src/lib/mcp-enable.ts) is the operator-facing layer that writes and
 * maintains it (the MCP and XAA JIT provisioners also create one when their
 * lookup finds none), and the XAA jwt-bearer grant (resources/XAA.ts,
 * `resolveOrCreatePrincipalLocked`) resolves an ID-JAG subject through it.
 * Before this module the resolver and the linker accepted every status except
 * `"revoked"`, so a principal-bearing row with a missing, empty or unknown
 * status was served as a live mapping; on the resolver's path a revoked row was
 * also skipped, so it could re-create a principal when JIT provisioning was
 * enabled. XAA already accepted only `"active"` (flair#2501). All three sites
 * now use this module's shared rule for row usability.
 *
 * The rule is an ALLOWLIST: a credential is usable only when its `status` is
 * exactly `"active"`. Missing, empty, `"revoked"` and any other value are not
 * usable. All three sites apply `credentialMapsPrincipal`: the row must also
 * name a principal, a non-empty string `principalId`. The schema requires
 * `principalId` and Harper refuses a write that omits it, but it stores an
 * empty string, and no site relies on the schema to exclude a row without one.
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

/**
 * The principal `cred` names: its `principalId` when that is a non-empty
 * string, otherwise null. The resolver, the linker and XAA all decide "names
 * no principal" with this one test.
 */
export function credentialPrincipalId(cred: { principalId?: unknown } | null | undefined): string | null {
  const principalId = cred?.principalId;
  return typeof principalId === "string" && principalId !== "" ? principalId : null;
}

/**
 * Does `cred` map a principal? It must be usable (`status === "active"`) and
 * name a principal. Anything else maps nothing.
 */
export function credentialMapsPrincipal(cred: { status?: unknown; principalId?: unknown } | null | undefined): boolean {
  return isUsableCredential(cred) && credentialPrincipalId(cred) !== null;
}

/** How a refusal names the status it found: the stored value, or that none was there. */
function credentialStatusPhrase(status: unknown): string {
  return status === undefined || status === null ? "no status" : `status ${JSON.stringify(status)}`;
}

/**
 * The named refusal for a Credential that maps no principal: it names the
 * actor (the named credential — pass the surrounding subject too when the
 * caller has one), the state (the stored status, or that there is none, and,
 * when applicable, that it names no principal) and the remedy (an operator
 * re-links the subject, which writes an active mapping that names its
 * principal). The resolver builds its JSON-RPC refusal from this, so that
 * wording has one home.
 */
export function credentialRefusal(actor: string, cred: { status?: unknown; principalId?: unknown }): string {
  const state = credentialPrincipalId(cred) === null
    ? `${credentialStatusPhrase(cred?.status)} and names no principal`
    : credentialStatusPhrase(cred?.status);
  return (
    `forbidden: ${actor} has ${state}; a Credential is usable only when its status is "active" and it names a ` +
    "principal, so it was not used and nothing was written. An operator must re-link the credential " +
    "(`flair mcp enable`, or `flair principal link`) to write an active mapping."
  );
}
