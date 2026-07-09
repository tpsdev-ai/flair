# Headless agent-auth to MCP — the Flair/consumer half

> **Status:** partial. Assertion signing (§1) and CIMD publish (§2) are built
> and tested. The live token round-trip (§3) is intentionally stubbed —
> pending HarperFast/oauth issue #162 (not yet a PR; contract not final).

This is the Flair-side consumer for RFC 7523 `client_credentials` +
`private_key_jwt` agent-auth: a headless Flair agent authenticating *as
itself* — no browser, no human — to a Harper MCP `/mcp` endpoint, using its
existing Ed25519 identity key. Design docs:
`~/ops/FLAIR-AGENT-AUTH-CONSUMER-SPEC.md`,
`~/ops/FLAIR-CLOUD-AGENT-BETA-ALIGNMENT.md`. Plugin side:
[HarperFast/oauth#159](https://github.com/HarperFast/oauth/issues/159)
(parent issue, decomposed into 4 parts).

## 1. Assertion signing — `flair mcp token` (built + tested)

`src/mcp-client-assertion.ts` builds + signs the `client_assertion` JWT:
header `{alg: "EdDSA", typ: "JWT"}`; claims `iss = sub = client_id`, `aud =
token endpoint`, `exp - iat ≤ 60s` (hard-capped, not just defaulted), `iat`,
random `jti`. Signed with `node:crypto` alone (no new dependency, matching
the plugin's own approach and this repo's existing `flair-client.mjs` /
`buildEd25519Auth` signing style).

This claim shape is pinned to what HarperFast/oauth PR #165
(`src/lib/mcp/clientAssertion.ts`, merged @ commit `d48c3b2`) verifies — read
directly from the PR diff, not guessed. `test/unit/mcp-client-assertion.test.ts`
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
mirrors `agentcard-fields.ts`'s pattern), tested against a mirror of
HarperFast/oauth PR #167's `validateCimdDocument` (`src/lib/mcp/cimd.ts`,
merged @ commit `f0da8a1`) in
`test/unit/mcp-client-metadata-fields.test.ts`.

### Pending #162 — the document we publish is the TARGET shape, not what #167 accepts today

Our document sets `grant_types: ["client_credentials"]` and
`token_endpoint_auth_method: "private_key_jwt"`, and omits `redirect_uris`.
Read directly against #167's merged code (not guessed):

1. `clientValidator.ts`'s `SUPPORTED_GRANT_TYPES` is `{authorization_code,
   refresh_token}` — `client_credentials` is rejected today.
2. `cimd.ts` hardcodes CIMD clients to `token_endpoint_auth_method ===
   'none'` — its own comment says `private_key_jwt` activates with #159.
3. `redirect_uris` is required + non-empty (inherited from the DCR-shaped
   validator) — meaningless for a pure client_credentials agent that never
   does a redirect flow. We deliberately did **not** invent a placeholder
   redirect URI (that could get silently accepted onto an unintended
   surface if a future validator loosens without also dropping this
   requirement) — we omit the field and fail closed instead.

Fetching our document against **today's** deployed AS 400s (missing/invalid
field) rather than silently downgrading to a weaker auth method. That's the
correct interim failure mode.

### Open questions for #162 (or a small follow-up PR to cimd.ts/clientValidator.ts)

- Will `SUPPORTED_GRANT_TYPES` gain `client_credentials`, and will CIMD's
  `token_endpoint_auth_method` check accept `private_key_jwt`, as part of
  #162 itself, or a separate follow-up?
- Will `redirect_uris` become optional for CIMD clients registered with
  `token_endpoint_auth_method: "private_key_jwt"` + `grant_types:
  ["client_credentials"]` (no redirect flow is ever possible for them), or
  is there a different expected answer (e.g. a client is expected to
  register a redirect URI anyway even if unused)?
- Client registration shape: does `register-mcp-client` (consumer spec §1)
  need anything beyond "the CIMD document is served at a stable URL" once
  the two gaps above close, or does #162 also expect an explicit
  admin-gated registration step (a `Credential`/allowlist row) separate from
  CIMD resolution? The consumer spec flags this as an open dependency; #162
  landing should resolve it.

## 3. Token round-trip — stubbed, pending #162

`requestMcpAccessToken` in `src/mcp-client-assertion.ts` always throws,
clearly marked `pending #162`. `buildTokenRequestForm` (pure, tested) shows
the request shape the design docs call for
(`grant_type=client_credentials`, `client_assertion_type=...jwt-bearer`,
`client_assertion`, `client_id`, RFC 8707 `resource`) — that's the contract
to wire up once #162 merges and its exact request/response shape (error
bodies, whether `resource` is required vs defaulted, discovery
advertisement) is final. Wiring a live POST against a moving-target issue
now would mean re-doing it; the stub keeps the seam explicit instead.

## What's NOT in this slice

- `flair agent register-mcp-client` (consumer spec §1's admin-gated
  Credential-writing command) — deferred until the open questions above
  resolve (registration shape depends on #162).
- The end-to-end loop + negative-path tests against a real spawned Harper
  (consumer spec's test plan) — needs the live grant to exist first.
