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
       enabled: true
       issuer: ${FLAIR_MCP_ISSUER}          # pin to your public origin — REQUIRED
       resource: ${FLAIR_MCP_ISSUER}/mcp     # RFC-8707 audience the /mcp token binds to
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
   - `FLAIR_MCP_OAUTH=1` — turns on the `/mcp` route registration.
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
