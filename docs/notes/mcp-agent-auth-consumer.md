# Headless agent-auth to MCP — the Flair/consumer half

> **Status:** partial. Assertion signing (§1) and CIMD publish (§2) are built
> and tested, including RFC 8707 `resource` pass-through in the token-request
> form builder. The live token round-trip (§3) is intentionally stubbed —
> pending HarperFast/oauth issue #162 (open issue, not yet a PR; itself
> depends on #161 and #167, both still open).

This is the Flair-side consumer for RFC 7523 `client_credentials` +
`private_key_jwt` agent-auth: a headless Flair agent authenticating *as
itself* — no browser, no human — to a Harper MCP `/mcp` endpoint, using its
existing Ed25519 identity key. Design docs:
`~/ops/FLAIR-AGENT-AUTH-CONSUMER-SPEC.md`,
`~/ops/FLAIR-CLOUD-AGENT-BETA-ALIGNMENT.md`. Plugin side:
[HarperFast/oauth#159](https://github.com/HarperFast/oauth/issues/159)
(parent issue, decomposed into 4 parts).

## Current oauth-side state (as of 2026-07-09)

| # | What | State |
|---|------|-------|
| #160 / PR #165 | client-assertion primitives (strict EdDSA verify + `jti` replay store) | **MERGED** |
| #161 | CIMD-first client resolution & validation for `private_key_jwt` agents — the formal CIMD shape spec | **OPEN** (re-scoped 2026-07-09 to CIMD-first; DCR demoted to optional back-compat) |
| #162 | token-endpoint grant — wires the assertion + resolved client + resource binding together | **OPEN ISSUE**, not yet a PR; depends on #161 and #167 |
| #167 | CIMD resolution layer (URL-shape detection, SSRF-guarded fetch, validation, cache, consent interstitial) | **OPEN DRAFT PR** — not merged |

A previous revision of this doc (and of the code comments in
`resources/mcp-client-metadata-fields.ts`) claimed "#167 merged @ commit
f0da8a1." That was inaccurate — #167 is an open draft. Corrected everywhere
2026-07-09.

## 1. Assertion signing — `flair mcp token` (built + tested)

`src/mcp-client-assertion.ts` builds + signs the `client_assertion` JWT:
header `{alg: "EdDSA", typ: "JWT"}`; claims `iss = sub = client_id`, `aud =
token endpoint`, `exp - iat ≤ 60s` (hard-capped, not just defaulted), `iat`,
random `jti`. Signed with `node:crypto` alone (no new dependency, matching
the plugin's own approach and this repo's existing `flair-client.mjs` /
`buildEd25519Auth` signing style).

This claim shape is pinned to what HarperFast/oauth PR #165
(`src/lib/mcp/clientAssertion.ts`, **merged** @ commit `d48c3b2`) verifies —
read directly from the PR diff, not guessed. `test/unit/mcp-client-assertion.test.ts`
includes a **mirror** of #165's verification contract (alg pinning, iss/sub/aud
exact match, exp/iat window, jti presence, Ed25519 signature check) and proves
assertions this module signs pass it, including negative cases (tampered
payload, wrong `aud`, wrong signing key, expired assertion).

Key loading (`resolveAgentKeyPath` / `loadEd25519PrivateKeyFromFile`) mirrors
`src/cli.ts`'s existing `resolveKeyPath` / `buildEd25519Auth` (used by the
TPS-Ed25519 REST-auth path) exactly: same search order (`--keys-dir` /
`FLAIR_KEY_DIR` / `~/.flair/keys` / `~/.tps/secrets/flair`), same format
cascade (raw 32-byte seed, base64 seed, base64 PKCS8 DER, PEM fallback). No
new key material, no new on-disk format.

CLI: `flair mcp token --agent-id <id> [--client-id <url>] [--token-endpoint
<url>] [--resource <url>] [--keys-dir <dir>] [--expires-in <seconds>]
[--json]`. `--client-id`/`--token-endpoint`/`--resource` default to this
Flair instance's own oauth surface (derived from `FLAIR_MCP_ISSUER` /
`FLAIR_PUBLIC_URL`, matching `resources/mcp-oauth-flag.ts`'s existing
`mcpIssuer()`/`mcpResource()` convention) but are fully overridable — an
agent can authenticate to a **different** Harper MCP server (identity is
portable; see the consumer spec's "Wiring / usage").

### RFC 8707 `resource` — already wired

`buildTokenRequestForm` (in `src/mcp-client-assertion.ts`) carries an
optional `resource` field, pass-through only (it never invents a value).
The CLI (`flair mcp token` in `src/cli.ts`) supplies the default:
`opts.resource ?? defaultMcpResource()`, where `defaultMcpResource()`
derives `${FLAIR_MCP_ISSUER}/mcp` — the same canonical resource identifier
`resources/mcp-oauth-flag.ts`'s `mcpResource()` uses for this instance's own
`/mcp` audience binding. This matches oauth#162's requirement: "accept the
RFC 8707 `resource` parameter, defaulting to the configured canonical
resource; exact-match, fail-closed." Tested in
`test/unit/mcp-client-assertion.test.ts` (`buildTokenRequestForm` describe
block + the `default*()` env-driven helpers block).

## 2. CIMD publish — `resources/MCPClientMetadata.ts` (built + tested)

Each agent's Client ID Metadata Document is **served**, not just generated:
`GET /MCPClientMetadata/{agentId}` (public, unauthenticated — mirrors
`AgentCard.ts`'s A2A-card posture). `client_id` = that URL itself (derived
from `mcpIssuer()`, same env vars as above); `jwks` = the agent's existing
`Agent.publicKey` re-expressed as a JWK OKP.

Why served rather than exported for external hosting: Flair already
publishes public agent-discovery metadata this way (`AgentCard.ts`), CIMD is
explicitly the **stateless**, Fabric-native registration path (no DCR row to
replicate across nodes — see the beta-alignment doc's Delta 2/4), and the
agent's public key is already Flair's source of truth. Serving it keeps that
single source of truth instead of introducing a second, externally-hosted
copy that could drift.

Field logic lives in `resources/mcp-client-metadata-fields.ts` (Harper-free,
mirrors `agentcard-fields.ts`'s pattern), shape-pinned to HarperFast/oauth
**issue #161** — the formal CIMD spec for `private_key_jwt` /
`client_credentials` agents — and tested against a mirror of #167's
(still-open-draft) `validateCimdDocument` (`src/lib/mcp/cimd.ts`) in
`test/unit/mcp-client-metadata-fields.test.ts`.

### Our document matches #161 exactly

- `grant_types: ["client_credentials"]`; `token_endpoint_auth_method:
  "private_key_jwt"` — exactly what #161 specifies.
- `jwks` = a JWK Set containing exactly one PUBLIC OKP/Ed25519 key.
  `buildCimdDocument` rejects: non-OKP/non-Ed25519 keys, a missing/malformed
  `x`, and — belt-and-suspenders — any JWK carrying a private `d` component
  (defensive; the TS type has no `d` field, but the function still checks
  at runtime since the input crosses a boundary from disk/network in some
  callers). An empty `jwks` set is structurally impossible through this
  API (it only ever accepts one already-validated key).
- `redirect_uris` and `response_types` are BOTH omitted — neither field is
  declared on the `CimdDocument` TypeScript type, so neither can leak back
  in via the object literal. This is exactly the conditional shape #161
  calls for: "client_credentials-only clients: no `redirect_uris`, no
  `response_types`."

### Still rejected by TODAY's #167 draft — expected, not a bug

Read directly against #167's current (unmerged) code:

1. `clientValidator.ts`'s `SUPPORTED_GRANT_TYPES` is `{authorization_code,
   refresh_token}` — `client_credentials` is rejected today.
2. `cimd.ts` hardcodes CIMD clients to `token_endpoint_auth_method ===
   'none'` — its own comment says `private_key_jwt` activates with #159.
3. `redirect_uris` is required + non-empty in today's validator (inherited
   from the DCR-shaped checks) — #161 will drop this requirement for
   client_credentials-only clients once it lands.

Fetching our document against **today's** deployed AS 400s (missing/invalid
field) rather than silently downgrading to a weaker auth method. That's the
correct interim failure mode, and it resolves itself with no code change on
our side once #161 (and the machinery it builds on, #167) merge.

## Open questions — RESOLVED by #161

The previous revision of this doc posed these as open questions against
#167's merged code. #161's issue text (re-scoped 2026-07-09) now answers
them formally:

- **Will `SUPPORTED_GRANT_TYPES` gain `client_credentials`, and will CIMD's
  `token_endpoint_auth_method` check accept `private_key_jwt`?** — Yes, both
  are explicitly in #161's scope ("Accept CIMD documents describing
  headless agents: `grant_types: ["client_credentials"]`,
  `token_endpoint_auth_method: "private_key_jwt"`").
- **Will `redirect_uris` become optional for CIMD clients registered with
  `private_key_jwt` + `client_credentials`?** — Yes. #161 explicitly blesses
  the conditional shape: "client_credentials-only clients: no
  `redirect_uris`, no `response_types`." This is now a documented,
  upstream-endorsed deviation from the CIMD draft's general required-fields
  list — not a guess we're hoping gets accepted.
- **Does client registration need an explicit admin-gated step beyond
  serving the CIMD document at a stable URL?** — No separate
  `Credential`/allowlist row is required. #161 replaces the DCR-shaped
  `initialAccessToken` gate with a **server-side host allowlist**:
  `clientIdMetadataDocuments.allowedHosts` must be configured on the AS, and
  our CIMD document's `client_id` URL host must be on it. Merely hosting a
  reachable document is explicitly NOT sufficient to mint tokens — the gate
  is AS-side config, not anything this repo publishes or asserts about
  itself. `flair agent register-mcp-client` (consumer spec §1) is therefore
  **not needed** for the CIMD path; it may still be worth building for the
  DCR back-compat path if that's kept, but that's optional per #161's scope
  ("DCR back-compat... may drop from v1").

### Deployment coordination note

Once #161/#162 land and this flows into a real deployment: whoever owns the
AS-side `@harperfast/oauth` config for a given Harper instance MUST add this
Flair instance's `MCPClientMetadata` host to
`clientIdMetadataDocuments.allowedHosts`. That host is derived from
`FLAIR_MCP_ISSUER` (or `FLAIR_PUBLIC_URL` as fallback) — the same env var
`mcpIssuer()` in `resources/mcp-oauth-flag.ts` and `defaultMcpClientId()` in
`src/mcp-client-assertion.ts` both read. If the allowlist isn't updated,
`/mcp` client_credentials auth for this agent fails closed (by design —
#161's gate is fail-closed, not fail-open) even once all the code above is
correct and deployed. This is an operational step, not a code change; flag
it explicitly when coordinating a rollout.

## 3. Token round-trip — stubbed, pending #162

`requestMcpAccessToken` in `src/mcp-client-assertion.ts` always throws,
clearly marked `pending #162`. `buildTokenRequestForm` (pure, tested) shows
the request shape the design docs — and now #162's own scope text — call
for: `grant_type=client_credentials`,
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
`client_assertion`, `client_id` (must equal the assertion's `iss`/`sub`, and
already does by construction here), and RFC 8707 `resource` (already
wired, see §1). That's the full contract to wire up once #162 merges and
its exact request/response shape (error bodies, discovery advertisement) is
final. Wiring a live POST against a moving-target issue now would mean
re-doing it; the stub keeps the seam explicit instead.

### What genuinely still needs #162 to land

- The actual HTTP round-trip (`requestMcpAccessToken`'s real
  implementation) — needs #162's real endpoint, error-response shapes, and
  discovery metadata to exist before there's anything to call.
- End-to-end / negative-path tests against a real spawned Harper running
  the merged plugin (replay rejection over real storage, wrong-resource
  rejection, TTL knob, audit hook firing) — needs #161, #162, and #167 all
  merged and wired together; a unit-level mirror can't substitute for this.
- Confirming the AS's discovery document actually advertises
  `grant_types_supported += client_credentials`,
  `token_endpoint_auth_methods_supported += private_key_jwt`, and
  `token_endpoint_auth_signing_alg_values_supported: ["EdDSA"]` as #162
  specifies — nothing to check against until it's deployed.
- `flair agent register-mcp-client` (consumer spec §1) — per the resolved
  open question above, this is likely NOT needed for the CIMD path at all;
  revisit once #161 merges and the `allowedHosts` gate is live in practice.

## What's NOT in this slice

- `flair agent register-mcp-client` — see above; deferred, likely
  unnecessary for the CIMD-first path once #161 lands.
- The end-to-end loop + negative-path tests against a real spawned Harper
  (consumer spec's test plan) — needs the live grant to exist first.
