/**
 * idp-mapping-rule.ts — which writes to an IdP identity mapping the Credential
 * resource (resources/Credential.ts) reserves for an administrator or the
 * server.
 *
 * An IdP identity mapping is a `Credential` row of kind "idp". The /mcp OAuth
 * resolver (resources/mcp-handler.ts) resolves a token's subject to the
 * principal named by the active idp row whose `idpSubject` is that subject,
 * and the XAA jwt-bearer grant (resources/XAA.ts) resolves to the principal
 * named by the active idp row whose `idpSubject` and `idpProvider` match the
 * assertion and its IdP configuration ("active" is exactly the status
 * src/lib/credential-status-rule.ts accepts). An administrator and trusted
 * server code write those rows: the /mcp and XAA JIT provisioners in-process,
 * and `flair mcp enable` / `flair principal link` through the operations API.
 *
 * Through the Credential resource, a caller that is neither an administrator
 * nor trusted server code:
 *   - cannot create a kind:"idp" row;
 *   - cannot change a row's kind to or from "idp";
 *   - cannot change an idp row's principalId, idpProvider or idpSubject;
 *   - cannot change an idp row's status to anything but "revoked", so cannot
 *     reactivate one;
 *   - may relabel its own idp row, revoke it, and delete it (DELETE is the
 *     owner check's, not this rule's).
 *
 * Dependency-free (imports nothing): resources/ imports it, and the
 * resource/CLI boundary guard (test/unit/resource-src-purity-1775.test.ts)
 * requires such a module to emit no module loads.
 */

/** The Credential kind that is an IdP identity mapping. */
export const IDP_KIND = "idp";

/** The named refusal for a write this rule does not allow the caller. */
export const IDP_MAPPING_ADMIN_ONLY = "idp_mapping_admin_only";

/** The refusal's message. It names the rule and carries nothing from the request. */
export const IDP_MAPPING_REFUSAL_MESSAGE =
  'forbidden: only an administrator or the server creates an IdP identity mapping (a Credential of kind "idp"), ' +
  "changes its kind or identity fields, or reactivates it; a principal may relabel, revoke or delete its own";

/**
 * The fields of an idp row, besides `kind` and `status`, that the two
 * resolvers use to decide which principal a subject resolves to: the subject
 * they match on (and, for XAA, the provider), and the principal the row names.
 */
export const IDP_MAPPING_IDENTITY_FIELDS: readonly string[] = Object.freeze(["principalId", "idpProvider", "idpSubject"]);

/** The one status a non-admin may set on its own idp row. */
export const IDP_SELF_SERVICE_STATUS = "revoked";

type Row = Record<string, unknown> | null | undefined;

/**
 * Does `kind` name an idp row? Also true for a multi-valued kind that includes
 * "idp", since an indexed attribute is matched per value.
 */
export function namesIdpKind(kind: unknown): boolean {
  return kind === IDP_KIND || (Array.isArray(kind) && kind.includes(IDP_KIND));
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Would a write that turns `stored` into `next` create an IdP identity
 * mapping, or change one in a way this rule reserves for administrators and
 * the server? `stored` is the row before the write (null or undefined when
 * the write creates it); `next` is the row as the write would store it. Pure.
 */
export function isIdpMappingChange(stored: Row, next: Row): boolean {
  // Neither side is a mapping: not this rule's business.
  if (!namesIdpKind(stored?.kind) && !namesIdpKind(next?.kind)) return false;
  // No stored row: the write creates a mapping.
  if (!stored || !next) return true;
  // The kind (to or from "idp") and the identity fields are fixed.
  for (const field of ["kind", ...IDP_MAPPING_IDENTITY_FIELDS]) {
    if (!sameValue(stored[field], next[field])) return true;
  }
  // The status may stay as it is or become "revoked".
  return !sameValue(stored.status, next.status) && next.status !== IDP_SELF_SERVICE_STATUS;
}
