# Headless agent-auth to MCP — the Flair/consumer half

> **Status:** complete against the published `@harperfast/oauth@2.2.0`, with
> one explicitly-drawn boundary: the full over-network CIMD fetch + token
> mint cannot be exercised end-to-end against a loopback Harper (the
> plugin's unconditional SSRF gate forbids it — by design, see
> [the SSRF/loopback boundary](#the-ssrfloopback-boundary) below). That last
> hop is deferred to a follow-up e2e against a real public HTTPS host;
> `bench.tps.harperfabric.com` is the planned venue.

This is the Flair-side consumer for RFC 7523 `client_credentials` +
`private_key_jwt` agent-auth: a headless Flair agent authenticating *as
itself* — no browser, no human — to a Harper MCP `/mcp` endpoint, using its
existing Ed25519 identity key. Plugin side:
[HarperFast/oauth#159](https://github.com/HarperFast/oauth/issues/159)
(parent issue, decomposed into 4 parts — all shipped, see below).

## Upstream state (as of 2026-07-12)

| # | What | State |
|---|------|-------|
| #160 / PR #165 | client-assertion primitives (strict EdDSA verify + `jti` replay store) | **SHIPPED** (merged @ `d48c3b2`) |
| #161 / #167 | CIMD-first client resolution & validation for `private_key_jwt` agents (SSRF-guarded fetch, validation, cache) | **SHIPPED** in 2.2.0 via PR #170 |
| #162 / PR #170 | token-endpoint grant — assertion + resolved client + RFC 8707 resource binding | **SHIPPED** in 2.2.0 |
| #163 / PR #171 | token-issuance rate limiting (per verified client_id, post-auth debit) | **SHIPPED** in 2.2.0 |

Every claim below about plugin behavior is read from the **published 2.2.0
package source** (`node_modules/@harperfast/oauth/dist/lib/mcp/*.js`) and,
where testable, proven against that real code — not mirrored, not guessed.
(History note: a 2026-07-09 revision of this doc corrected an earlier false
"#167 merged" claim; #167 has since genuinely shipped as part of 2.2.0.)

## 1. Assertion signing + live token mint — `flair mcp token`

`src/mcp-client-assertion.ts` builds + signs the `client_assertion` JWT:
header `{alg: "EdDSA", typ: "JWT"}`; claims `iss = sub = client_id`, `aud =
token endpoint`, `exp - iat ≤ 60s` (hard-capped, not just defaulted), `iat`,
random `jti`. Signed with `node:crypto` alone (no new dependency, matching
the plugin's own approach and this repo's existing `flair-client.mjs` /
`buildEd25519Auth` signing style). The claim shape is pinned to what PR #165
(`src/lib/mcp/clientAssertion.ts`) verifies, and
`test/unit/mcp-client-credentials-live-package.test.ts` proves assertions
this module signs pass the plugin's **real** `verifyClientAssertion` —
including negative cases (wrong signing key, tampered payload).

Key loading (`resolveAgentKeyPath` / `loadEd25519PrivateKeyFromFile`) mirrors
`src/cli.ts`'s existing `resolveKeyPath` / `buildEd25519Auth` (used by the
TPS-Ed25519 REST-auth path) exactly: same search order (`--keys-dir` /
`FLAIR_KEY_DIR` / `~/.flair/keys` / `~/.tps/secrets/flair`), same format
cascade (raw 32-byte seed, base64 seed, base64 PKCS8 DER, PEM fallback). No
new key material, no new on-disk format.

### The live round-trip (formerly stubbed — now real)

`requestMcpAccessToken` POSTs the `client_credentials` grant to the token
endpoint (`/oauth/mcp/token`) and returns the minted token. Its error
behavior is deliberate:

- **429 `slow_down`** (the #171/#163 issuance rate limit): honors the
  `Retry-After` header with **full jitter** (sleep a random duration in
  `[0, Retry-After]`), retrying up to `maxRetries` (default 3 — an
  assertion is only valid ≤ 60s, so unbounded retry would outlive it).
  A missing `Retry-After` falls back to capped exponential backoff — never
  hammer, even a non-conformant server.
- **Any other non-2xx** throws `McpTokenRequestError` (status + OAuth error
  code preserved) with **no retry** — those responses mean the request
  itself is wrong, and retrying identically would just burn a fresh `jti`.

`getMcpAccessToken` wraps it with the consumer-side requirements the 2.2.0
rate limiter creates (pinned in flair#663's tracking thread): **mint
sparingly** — tokens are cached per `(clientId, tokenEndpoint, resource)`
and reused until within a refresh margin (default 30s) of expiry, because
the limiter debits per *mint*, not per use. `forceRefresh` bypasses the
cache (e.g. after an unexpected 401).

CLI: `flair mcp token --agent-id <id>` now performs the real mint by
default; `--dry-run` restores the old sign-and-print behavior.
`--client-id`/`--token-endpoint`/`--resource` default to this instance's own
oauth surface (derived from `FLAIR_MCP_ISSUER` / `FLAIR_PUBLIC_URL`,
matching `resources/mcp-oauth-flag.ts`) but are fully overridable — an
agent can authenticate to a **different** Harper MCP server; identity is
portable.

### RFC 8707 `resource`

`buildTokenRequestForm` carries an optional `resource` field, pass-through
only (it never invents a value). The CLI supplies the default:
`${FLAIR_MCP_ISSUER}/mcp`, the same canonical resource identifier
`resources/mcp-oauth-flag.ts`'s `mcpResource()` uses for this instance's own
`/mcp` audience binding — exact-match, fail-closed on the AS side. The
`resource` is part of the token-cache key: a token minted for one resource
never serves another.

## 2. CIMD publish — `resources/MCPClientMetadata.ts`

Each agent's Client ID Metadata Document is **served**, not just generated:
`GET /MCPClientMetadata/{agentId}` (public, unauthenticated — mirrors
`AgentCard.ts`'s A2A-card posture). `client_id` = that URL itself (derived
from `mcpIssuer()`, same env vars as above); `jwks` = the agent's existing
`Agent.publicKey` re-expressed as a JWK OKP.

Why served rather than exported for external hosting: Flair already
publishes public agent-discovery metadata this way (`AgentCard.ts`), CIMD is
explicitly the **stateless** registration path (no DCR row to replicate
across Fabric nodes), and the agent's public key is already Flair's source
of truth. Serving it keeps that single source of truth instead of
introducing a second, externally-hosted copy that could drift.

Field logic lives in `resources/mcp-client-metadata-fields.ts` (Harper-free,
mirrors `agentcard-fields.ts`'s pattern), shape-pinned to oauth#161:

- `grant_types: ["client_credentials"]`; `token_endpoint_auth_method:
  "private_key_jwt"`.
- `jwks` = a JWK Set containing exactly one PUBLIC OKP/Ed25519 key.
  `buildCimdDocument` rejects non-OKP/non-Ed25519 keys, a missing/malformed
  `x`, and any JWK carrying a private `d` component (defensive runtime
  check; the TS type has no `d` field).
- `redirect_uris` and `response_types` are BOTH omitted — neither exists on
  the `CimdDocument` type, so neither can leak back in. This is the
  conditional shape #161 specifies for client_credentials-only clients.

This document is proven against the plugin's **real published pipeline**:
`test/unit/mcp-client-credentials-live-package.test.ts` drives 2.2.0's
actual `resolveCimdClient` (fetch → SSRF gate → validate → cache) via its
exported `_setDnsLookup`/`_setFetch` test hooks and confirms the document
resolves end-to-end, plus the fail-closed negatives: no
`clientIdMetadataDocuments.allowedHosts` configured → rejected even though
the fetch succeeded, and a document with leaked private-key material →
rejected by the plugin's validator even if our own build-time guard were
bypassed.

## 3. Test evidence — three layers, strongest available at each boundary

1. **Mirror unit tests** (`test/unit/mcp-client-assertion.test.ts`) — our
   signer vs. a local mirror of #165's verification contract, all negative
   cases; plus the full `requestMcpAccessToken`/`getMcpAccessToken` behavior
   matrix (429 backoff with and without `Retry-After`, retry exhaustion,
   non-JSON responses, cache reuse/expiry/`forceRefresh`/per-resource
   isolation) against an injected fetch.
2. **Live-package unit tests**
   (`test/unit/mcp-client-credentials-live-package.test.ts`) — no mirrors:
   the REAL published 2.2.0 `verifyClientAssertion`, `resolveCimdClient`,
   and `createRateLimiter` composed in-process. Includes the
   post-auth-debit ordering proof (#171/#163): a forged assertion never
   reaches the rate limiter, so it cannot drain a real client's bucket; and
   the exact-`Retry-After` handshake between the plugin's limiter and our
   client backoff.
3. **Live-Harper e2e**
   (`test/integration/mcp-client-credentials-e2e.test.ts`) — an ephemeral
   Harper (via `test/helpers/harper-lifecycle.ts`) running
   `@harperfast/oauth@2.2.0` as a real mounted component. Proves, over real
   HTTP: the AS discovery document advertises
   `client_credentials`/`private_key_jwt`/`EdDSA`; our CIMD document is
   served correctly; a real grant naming our agent reaches CIMD resolution
   and is rejected **only** by the SSRF/DNS gate (distinguishable from both
   shape errors and the allowlist gate, which is proven live and distinct);
   and our client helper surfaces the rejection as a typed error.

## The SSRF/loopback boundary

Read this before trying to "finish" the e2e locally — the wall is real and
it is the plugin working as designed, not a bug:

`@harperfast/oauth@2.2.0`'s CIMD document fetch (`dist/lib/mcp/cimd.js`)
enforces an **unconditional SSRF gate**: the `client_id` URL must be
`https://` (no loopback carve-out — contrast `mcp.issuer`'s explicit
loopback TLS exception, which has no analog here), and every DNS-resolved
address is checked against the full IANA private/loopback/link-local ranges
with **no override or allowlist knob**. A CIMD document served by a
loopback/private-network Harper can therefore never be fetched by the AS
over a real network hop. Consequences, all verified empirically while
building this slice:

- The plugin's `_setDnsLookup`/`_setFetch` injection hooks only help when
  the test and the plugin run in the **same process**. A spawned Harper
  (the `harper-lifecycle.ts` pattern) does not share the test's module
  registry.
- Harper's component loader gives each `package:`-declared component an
  **isolated module graph even within the same process** — a same-process
  JS resource that deep-imports `cimd.js` and arms the hooks on its own
  import instance does not affect the module instance the plugin's
  `/oauth/mcp/token` route uses (confirmed by direct experiment: the
  harness's own `resolveClient` call succeeded against the mocked
  transport; the live HTTP endpoint, hit immediately after, still failed
  with the identical SSRF rejection).
- Seeding the DCR client store is not a bypass either:
  `MCPClientStore`'s `encodeRecord`/`decodeRecord`
  (`dist/lib/mcp/clientStore.js`) persist no `jwks`/`_cimd` fields, so a
  stored client can never satisfy `handleClientCredentialsGrant`'s
  `client._cimd !== true` gate — confirmed by reading the published source.

So the local e2e drives the live grant as far as it can physically go —
into CIMD resolution, stopped only by the DNS gate — and the remaining
behavior (the plugin's real fetch of our served document, followed by a
200 token mint over the network) is covered in-process by the live-package
tests instead. **The genuine end-to-end over-network mint is deferred** to
an environment where this Flair instance's CIMD route is served from a
real, publicly-resolvable HTTPS host. Planned follow-up: run exactly
`test/integration/mcp-client-credentials-e2e.test.ts`'s happy path against
`bench.tps.harperfabric.com` (our public bench host) with
`clientIdMetadataDocuments.allowedHosts` pointed at it — at which point the
SSRF-gate rejection assertion flips into a 200-mint assertion. Until that
runs, "token mints over a real network hop" remains **inferred** from the
in-process proof, not measured; everything else above is measured.

## Deployment coordination note

Whoever owns the AS-side `@harperfast/oauth` config for a given Harper
instance MUST add this Flair instance's `MCPClientMetadata` host to
`clientIdMetadataDocuments.allowedHosts`. That host is derived from
`FLAIR_MCP_ISSUER` (or `FLAIR_PUBLIC_URL` as fallback) — the same env var
`mcpIssuer()` in `resources/mcp-oauth-flag.ts` and `defaultMcpClientId()` in
`src/mcp-client-assertion.ts` both read. If the allowlist isn't updated,
`/mcp` client_credentials auth for this agent fails closed (by design; the
e2e proves the "Unknown client" rejection live). This is an operational
step, not a code change; flag it explicitly when coordinating a rollout.
The AS must also be able to fetch that host over public HTTPS — see the
SSRF boundary above.

## What's NOT in this slice

- The over-network CIMD fetch + 200 token mint e2e — deferred to the
  public-host follow-up described above.
- `flair agent register-mcp-client` — not needed for the CIMD path (#161
  replaced the DCR-shaped registration gate with the AS-side host
  allowlist); only worth revisiting if DCR back-compat ever matters.
- Wiring the minted access token into an actual MCP client session
  (`Authorization: Bearer` against `/mcp`) — the token is minted and
  cached; consuming it is the natural next slice.
