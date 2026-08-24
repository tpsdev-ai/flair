# Native /mcp OAuth surface — Model 2 (experimental, default-OFF)

> **Status: experimental, opt-in, DEFAULT-OFF.** Gated behind `FLAIR_MCP_OAUTH`.
> When the flag is unset, flair boots byte-identically to before — no `/mcp`
> route, no authorization-server load, no change to the default auth chain.
> Do NOT enable in production until Sherlock signs off on live enablement.

This is the **Model 2** native-MCP path: a custom in-process `/mcp` JSON-RPC
handler guarded by `@harperfast/oauth`'s `withMCPAuth`, serving the 9 curated
flair tools with a per-agent OAuth identity. It is distinct from the
native-application-MCP surface (design A / `FLAIR_MCP_ENABLED`); Model 2 does not
use Harper's native MCP transport, so it is not blocked by the Harper native-MCP
gating gaps.

## What it is

- `resources/mcp-handler.ts` — a minimal MCP (JSON-RPC 2.0) handler over
  Streamable HTTP: `initialize` / `tools/list` / `tools/call` / `ping`. On
  `tools/call` it resolves the verified token `sub` → a flair `Agent`, then
  dispatches to the curated tool.
- `resources/mcp-tools.ts` — the 9 curated tools (memory_search, memory_store,
  memory_get, memory_delete, bootstrap, soul_set, soul_get, flair_workspace_set,
  flair_orgevent), each a thin wrapper over the existing resource handler
  (Memory / SemanticSearch / BootstrapMemories / Soul / WorkspaceState /
  OrgEvent). No raw CRUD surface — the only path to the datastore through `/mcp`
  is one of these 9 semantic tools. Curated **by construction**.
- `resources/mcp-oauth.ts` — registers `server.http(withMCPAuth(mcpHandler),
  { urlPath: '/mcp' })` **only when `FLAIR_MCP_OAUTH` is on.** `/mcp` runs on its
  own dispatch chain; flair's default auth-middleware does not run for it.
- `resources/mcp-oauth-flag.ts` — the flag + issuer/resource config helpers.

## The sub → Agent mapping (identity)

`withMCPAuth` verifies the RS256 JWT and sets `request.mcp = { sub, client_id,
aud, scope }`. The handler maps `sub` → a flair `Agent` id:

1. Look up `Credential` where `kind === "idp"` AND `idpSubject === sub` → its
   `principalId` is the Agent id. (Same credential surface XAA's ID-JAG path
   uses — one identity model.)
2. If no mapping and `FLAIR_MCP_JIT_PROVISION` is on, JIT-provision a
   non-admin `Agent` + `Credential(kind:"idp")` from the sub.
3. Otherwise **deny** — an unresolvable sub never runs as anonymous or admin.

The resolved agent is set as `request.tpsAgent` on a flair-shaped delegation
context, so the wrapped handler scopes to the verified agent exactly as an
Ed25519-signed REST call would. Identity always comes from the resolved agent,
never from the tool arguments (no forging of agentId / authorId).

### Which Agent is my connector? (distinct-by-default — flair#1280)

**The connector's Agent is whatever the `Credential(kind:"idp")` mapping says
— and that is NOT constrained to be your CLI agent.** Distinct identities are
the ruled default (flair#1280): per-purpose connector identities are the
product pattern for org/service installs, and same-identity is a deliberate
opt-in, never something the server infers. The practical consequences:

- **Where the mapping is decided.** `flair mcp enable --principal <agent-id>
  --idp-subject <sub>` (the identity-mapping step, backed by
  `provisionIdpIdentityMapping`) writes the mapping. The `--principal` you pass
  is the Agent every `/mcp` call will read and write as. Pass an EXISTING
  agent id to attach the sub to it; the step's output states the resulting
  `sub → Agent` mapping in as many words.
- **Linking a sub to an existing Agent (the same-identity opt-in).** Re-run
  `flair mcp enable` with the SAME `--idp-subject` and `--principal
  <your-cli-agent-id>`. The existing Credential for that subject is RE-POINTED
  to that principal — one ACTIVE Credential row per subject, so resolution stays
  deterministic. The link *replaces* the mapping; it does not merge the two
  agents' memories.
- **First diagnostic: ask the server who you are.** The `bootstrap` tool's
  response always carries the resolved `agentId` and a `scope` descriptor
  (`scope.agentId` / `scope.isAdmin` / `scope.reads`, flair#1182). "My memory
  is empty over the connector" + a `bootstrap.agentId` you don't recognize =
  the sub resolved to a different (often JIT-provisioned) Agent — link it as
  above.
- **Re-linking under a different provider name SUPERSEDES (flair#1317).** A
  JIT-provisioned mapping (`FLAIR_MCP_JIT_PROVISION=1`) stamps `idpProvider:
  "mcp-oauth"`, so re-linking that sub as, say, `github` is a *provider change*.
  The invariant is **at most one ACTIVE `Credential(kind:"idp", idpSubject)` per
  subject, regardless of provider** — the same key runtime resolution uses. So
  the link revokes the prior credential (terminal `status: "revoked"`, the row
  retained for audit) and writes the new one, in a single batched write. You do
  NOT need to match `--idp-provider` to the JIT stamp, and you do not need to
  revoke anything by hand first. `provisionIdpIdentityMapping` returns
  `credentialSuperseded: true` with the revoked ids, and the `flair mcp enable`
  identity-mapping step prints them.

  Read `credentialSuperseded` as **"the prior credential for this subject is now
  dead"**, not "a duplicate was tidied up". `idpProvider` is audit/diagnostic
  metadata on the row; it does not namespace the subject. Residual risk, ruled
  acceptable (Sherlock, #1317): anyone who can run the link for a subject can
  revoke that subject's existing credential, so two genuinely different people
  sharing one subject string across providers would evict each other. IdP
  subjects are opaque per-IdP identifiers, so this is remote — and the
  alternative, duplicate active credentials resolved by iteration order, is
  strictly worse.

  Before the fix, the linking upsert deduped on `(kind, idpProvider,
  idpSubject)` while resolution read `(kind, idpSubject)`, so a cross-provider
  re-link silently created a SECOND active credential and which one won was
  unspecified.

The two-identity contract (a distinct connector agent sees other agents'
org-non-private rows, never their private rows, 404-never-403 by id; a linked
connector sees exactly what the linked agent sees) is pinned end-to-end by
`test/integration/mcp-connector-principal-mapping.test.ts`, which drives the
real `mcpHandler`/`resolveAgentFromSub` against a real store with two
registered identities.

## Enabling (operator checklist)

1. **Install the AS plugin** — add `@harperfast/oauth` (already an exact-pinned
   dependency) and declare it in `config.yaml`:

   ```yaml
   '@harperfast/oauth':
     package: '@harperfast/oauth'
     providers:
       github:
         clientId: ${OAUTH_GITHUB_CLIENT_ID}
         clientSecret: ${OAUTH_GITHUB_CLIENT_SECRET}
     mcp:
       enabled: ${FLAIR_MCP_OAUTH}          # whole-token env reference (flair#1152) — the choice lives in the ENVIRONMENT, so a re-packed deploy can't revert it
       issuer: ${FLAIR_MCP_ISSUER}          # pin to your public origin — REQUIRED
       # NO resource key (flair#1180): the plugin derives <issuer>/mcp when it is
       # absent. A composite like ${FLAIR_MCP_ISSUER}/mcp never interpolates
       # (whole-token-only expansion) and fails every connect with
       # invalid_target. Non-standard resource: set an explicit LITERAL URL.
       accessTokenTtl: 900                    # 5–15 min (Sherlock req 1) — short-lived
       dynamicClientRegistration:
         enabled: false                       # DCR is NOT SUPPORTED (flair#756) — explicit, not omitted (an absent block leaves DCR OPEN by the plugin's own default)
       clientIdMetadataDocuments:
         allowedHosts:                        # CIMD is the only supported client-registration path
           - claude.ai
           - claude.com
       signingKeyPem: ${FLAIR_MCP_SIGNING_KEY_PEM}    # pin in clusters
   ```

   **DCR is not supported; clients connect via CIMD (Client ID Metadata
   Documents).** `flair mcp enable` (flair#756) writes exactly this shape —
   see "Legacy clients" below.

   The `config.yaml` block is intentionally NOT committed to the live config in
   this slice — adding it changes boot behavior, which would break the
   default-OFF / byte-identical contract. An operator adds it deliberately when
   turning the surface on.

2. **Set the env:**
   - `FLAIR_MCP_OAUTH=true` — turns on the `/mcp` route registration AND the
     component AS (flair#1152: `true` is the ONE value both readers accept —
     flair's flag takes 1/true/yes/on, but the component's config read of the
     same var accepts only "true"/"false" and deletes anything else, so `1`
     gives you a guarded `/mcp` with no authorization server behind it).
   - `FLAIR_MCP_ISSUER=https://your-public-origin` (or `FLAIR_PUBLIC_URL`).
   - `FLAIR_MCP_JIT_PROVISION=1` — ONLY if you want unknown subjects
     auto-provisioned (default OFF; pre-provision Agent+Credential otherwise).

3. **Restart flair.** `/mcp` mounts, OAuth-guarded.

## Sherlock's 4 requirements — how they are met

1. **Token lifetime.** `mcp.accessTokenTtl: 900` (5–15 min) in the AS config +
   the standard OAuth refresh flow (the plugin rotates refresh tokens on use).
   `withMCPAuth` validates `exp` strictly. Documented as a required config value,
   not a default (the plugin's own default is 1h — too long).
2. **RS256 pinning.** The `@harperfast/oauth` plugin mints and verifies RS256-only
   (per its docs: "Signing algorithms other than RS256 … are not supported"), so
   `none`/HS256 confusion is structurally rejected — the verifier only knows
   RS256. No configurable `alg` to widen.
3. **Dual-auth precedence.** `/mcp` is OAuth-only on its own urlPath chain;
   flair's default chain (Ed25519) never runs for `/mcp`, and the OAuth Bearer
   never reaches the default chain. They cannot collide on the same request —
   `/mcp` sees only the token, every other path sees only Ed25519/Basic. There is
   no path that carries both.
4. **Client registration.** DCR is not supported; clients connect via CIMD
   (Client ID Metadata Documents) — `mcp.dynamicClientRegistration.enabled:
   false` explicitly closes RFC 7591 registration (open DCR would let an
   attacker register as any agent; leaving the block unset does NOT close it —
   see `src/lib/mcp-enable.ts`'s module header for the ground-truth citation),
   and `mcp.clientIdMetadataDocuments.allowedHosts` restricts which hosts may
   present a CIMD client_id URL. On the resolution side, JIT-provisioning of
   an unknown sub is itself gated (`FLAIR_MCP_JIT_PROVISION`, default OFF) —
   a second explicit trust anchor.

## Legacy clients

DCR (RFC 7591 Dynamic Client Registration) is UNSUPPORTED on this surface —
not a fallback, not a flag. `flair mcp enable` (flair#756) writes
`dynamicClientRegistration: { enabled: false }`, which 404s
`/oauth/mcp/register`. A client that cannot present a CIMD client_id URL
cannot connect to this surface.

## Deferred (not in this slice)

- Live `config.yaml` wiring of the `@harperfast/oauth` plugin (kept out to
  preserve the byte-identical flag-OFF contract; documented above for operators).
- Migrating the homegrown `OAuth.ts` / `XAA.ts` opaque-token AS to the plugin.
  Per Kern: deprecate-don't-delete — they stay for the Ed25519/signed-REST path.
  XAA's JIT-provisioning is kept; the Model-2 handler reuses the same
  `Credential(kind:"idp")` surface.
