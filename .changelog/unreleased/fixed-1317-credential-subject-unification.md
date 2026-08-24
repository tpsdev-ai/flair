- **Identity mapping now enforces one active IdP credential per subject, so
  re-linking a connector under a different provider name supersedes instead of
  creating a duplicate whose resolution depended on iteration order
  (flair#1317).** `provisionIdpIdentityMapping` deduplicated on
  `(kind, idpProvider, idpSubject)` while `resolveAgentFromSub` resolves on
  `(kind, idpSubject)`. A re-link under a new provider name — the ordinary case
  when a JIT-provisioned sub (stamped `idpProvider: "mcp-oauth"`) is linked as,
  say, `github` — matched nothing to reuse and INSERTED a second credential.
  Both were `status: "active"` and both matched the resolver's filter, so which
  Agent a token subject resolved to came down to whichever row the search
  iterator served first: nondeterministic identity resolution on a
  security-relevant mapping. Per the K&S ruling on #1317, the resolver's key is
  the correct one and is unchanged; the linking layer now enforces the
  uniqueness constraint the resolver already assumed. A cross-provider re-link
  revokes the prior credential (terminal `status: "revoked"`, row retained for
  audit, never resurrected by a later link) and writes the new one in a single
  batched ops-API write with the survivor first, so there is no observable
  two-active or zero-active window; the invariant is then re-read from the store
  and a violation throws rather than returning a mapping that looks
  deterministic and is not. `idpProvider` stays on the row as audit metadata but
  no longer namespaces the subject. The result carries `credentialSuperseded` +
  `supersededCredentialIds`, and `flair mcp enable`'s identity-mapping step
  prints them as a revocation, not a de-duplication — an operator must not learn
  about it later from something that stopped working. The same path heals stores
  that the old key already left with several active credentials on one subject.
  Pinned by `test/integration/mcp-connector-principal-mapping.test.ts` (e), which
  reads two active credentials on unmodified main, and by (f), which proves a
  revoked credential does not resolve at all — not merely that it loses a race.
