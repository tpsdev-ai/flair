# Authentication & Authorization

Flair supports three authentication methods, from simplest to most enterprise-ready.

## Auth across surfaces (read this first)

Different surfaces authenticate differently. The model in one place:

| Surface | Auth | Scope | Notes |
|---------|------|-------|-------|
| **CLI / SDK clients** (`flair`, `flair-client`) | **Ed25519 per-agent** | Own writes; org-wide non-private reads | Default, recommended. Signs every request; an agent can never write as another, and reads are scoped to its own memories (any visibility) plus every other agent's **non-private** memories on the instance. |
| **MCP server** (`@tpsdev-ai/flair-mcp`) | **Ed25519 per-agent** | Own writes; org-wide non-private reads | Same per-agent identity as the CLI — key auto-resolved from `~/.flair/keys/<agent>.key`. |
| **OpenClaw / pi / Hermes plugins** | **Ed25519 per-agent** | Own writes; org-wide non-private reads | Same secure path; auto-detect agent identity. |
| **`n8n-nodes-flair`** | **Harper admin-password Basic auth** | ⚠️ **Whole instance, read + write, including `private`** | The admin credential bypasses agent scoping entirely — every workflow gets read/write on the *entire* memory store, including other agents' `private`-marked memories, not just the org-wide non-private pool an Ed25519 identity would see. |

**The default, secure path is Ed25519 per-agent** (see below): each agent holds its own key and signs every request. That guarantees **write isolation** — no agent can write as another — and identity-verified reads. It does **not** mean cross-agent reads are refused: within one Flair instance (one org), any verified agent can read any other agent's memory unless that memory is explicitly marked `visibility: private` (owner-only). The hard access boundary is the **federation edge** (a separate Flair instance / org), not reads within an instance. See [SECURITY.md](../SECURITY.md) for the full model. Use Ed25519 per-agent everywhere you can regardless — it's still what makes writes and identity trustworthy.

### Known limitation — n8n uses admin-password Basic auth

The `n8n-nodes-flair` community node authenticates with the Harper **admin password** (Basic auth), which bypasses agent scoping entirely — not just the org-wide non-private reads an Ed25519 identity already gets. Concretely, an n8n workflow using the admin credential can write memories under *any* agent's identity (no per-agent write isolation) and can read *every* memory including ones marked `visibility: private` (which stay owner-only under normal Ed25519 auth). This is acceptable only when **all** of the following hold:

- The n8n instance is single-tenant and operator-controlled.
- Workflow inputs are trusted (your own CRM, your own webhook source).
- Write-forgery and full read access (including `private` memories) are acceptable for the use case.

If any of those don't hold, use Flair's CLI / SDK clients (which support per-agent Ed25519 today) and wait for the n8n credential to gain Ed25519 per-agent auth (planned). Full guidance in [docs/n8n.md](n8n.md#security).

## Ed25519 Agent Auth (Default)

Every agent has an Ed25519 key pair. Requests are signed with `agentId:timestamp:nonce:METHOD:/path` and verified against the agent's registered public key. 30-second replay window with nonce deduplication.

```bash
# Register an agent
flair agent add myagent

# The key is stored at ~/.flair/keys/myagent.key
# Requests are signed automatically by flair-client and the MCP server
```

This is the default and recommended auth for single-instance deployments.

## Deployment shapes: personal vs org

Flair has no `mode`/`shape` config setting — the shape you get is emergent from *how you provision principals*, not something you declare:

- **Personal (the default).** `flair init` mints ONE agent identity and wires that same `FLAIR_AGENT_ID` into every MCP client it configures (Claude Code, Codex, Gemini, Cursor). One human driving several AI clients ends up with one canonical principal and one Ed25519 keypair — all clients share ownership of the same memory. This is intentional, not a limitation: all clients see each other's private rows (one human's memory, one view), a fact re-asserted from two different clients dedups to one memory, and usage counting treats the principal as one contributor.
- **Org (multiple real agents).** `flair agent add <id>` mints a distinct principal — its own keypair, its own ownership boundary — for each real agent that should be a separate identity. Wire each principal's own `FLAIR_AGENT_ID` into its own client(s).

Nothing in flair validates which shape you're in; a personal install that later grows into an org just runs `flair agent add` for the new distinct identities it needs.

### Authorship: which client wrote a row

The personal shape's one shared principal means `agentId` alone can't answer "was this written by Claude Code or Codex?" — every write it receives has the same owner. `flair init`'s per-client wiring closes that gap by setting an additional env var per client: `FLAIR_CLIENT` (`"claude-code"` / `"codex"` / `"gemini"` / `"cursor"`). `flair-client` and `flair-mcp` forward it on memory writes as `claimedClient`, and the server folds it into the write's `provenance` blob as `claimed.client` — self-reported, unverified metadata recording *which tool* authored a row, alongside the existing `claimed.model`.

This is deliberately in `claimed`, never `verified`: it carries **zero authority**. It is never read for access control, read-scope, attribution weighting, or dedup decisions — it exists purely for audit/analysis. Absent on any install that predates this field (no backfill, no migration) and absent whenever a client doesn't set `FLAIR_CLIENT`.

The native `/mcp` OAuth surface (see below) doesn't need any client-side wiring at all: the handler stamps `claimed.client` directly from the OAuth token's verified `client_id` claim — the server-generated `flair_cl_...` machine id assigned at Dynamic Client Registration, **not** the user-supplied `client_name` (which the registering client fully controls and could set to anything). Using `client_id` keeps the stamp a stable, server-verified label even though it still only carries `claimed`-level (unverified-by-content) authority.

## OAuth 2.1

Flair includes a built-in OAuth 2.1 authorization server for client integrations (e.g., Claude connecting to Flair as an MCP server).

### Dynamic Client Registration

**Registration is off by default.** `POST /OAuthRegister` answers `403
access_denied`, and the discovery documents do not advertise a
`registration_endpoint`. Nothing needs doing to be in this state — it is what a
fresh install does, and it is what an internet-reachable instance should stay in
unless there is a reason otherwise.

`OAuthClient` rows are durable and replicated, and every one of them is a
`client_id` that `/OAuthAuthorize` will subsequently honour, so an open
registration endpoint on a public instance means anyone can fill that table.

To turn registration on, set an initial access token (RFC 7591 §3.1):

```sh
FLAIR_OAUTH_DCR_TOKEN=$(openssl rand -base64 32)
```

That one variable is the whole interface. There is no separate "enable" switch,
which is the point: enabling registration and supplying the credential that
guards it are the same act, so "on, and open to the internet" is not a state you
can reach by forgetting a setting — it does not exist in the configuration. A
token outside 32–508 characters is refused and registration stays **off**, with
a warning naming the variable; a weak shared secret on an unauthenticated public
endpoint is nearer to open than to closed.

Registration is also rate limited, and the limiter runs **in front of** this
gate: refused attempts spend budget too, so a flood against a closed endpoint is
answered `429`, not `403`. That is deliberate — the limiter is the cheaper check
and the one bounding volume — but it means a client retrying hard against an
instance that has not opted in sees `429` and should read it as "stop", not as a
different answer to the same question. The budget is 5 per five minutes by
default (`FLAIR_OAUTH_REGISTER_RATE_LIMIT`).

Keep the token in the process environment. Do not put it in a component `.env`
for `flair deploy` to ship — a deploy payload is stored in Harper's deployment
record and replicated to every node. `flair deploy` refuses to generate one
containing this key, and warns if your own file assigns it.

Clients then present it in a request header:

```
POST /OAuthRegister
Content-Type: application/json
X-Flair-Initial-Access-Token: <the token>

{
  "client_name": "Claude Desktop",
  "redirect_uris": ["https://claude.com/api/mcp/auth_callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Returns `client_id`. A missing or wrong token answers `401 invalid_token`.

**Why a header and not `Authorization: Bearer`,** which is what RFC 7591 §3.1
specifies: Harper's own auth layer claims every `Authorization: Bearer …` header
and validates it as a Harper operation token, so a Bearer-carrying request to
`/OAuthRegister` is answered `401 {"error":"invalid token"}` before any Flair
code runs. Measured, not assumed — no header returns 200, `Bearer <anything>`
returns 401, a custom header returns 200.

Registering clients ahead of time and leaving this off is the better shape where
it is workable — the surface exists to serve one known client shape, and the
`@harperfast/oauth` authorization server used by the `/mcp` surface takes CIMD
rather than registration.

### Authorization Code Flow with PKCE

Standard OAuth 2.1 authorization code flow:

1. Client generates PKCE `code_verifier` and `code_challenge`
2. Client redirects user to `GET /OAuthAuthorize?client_id=...&code_challenge=...&redirect_uri=...`
3. User approves (or auto-approves for trusted clients)
4. Flair redirects back with authorization code
5. Client exchanges code for access token at `POST /OAuthToken`

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/OAuthRegister` | POST | Dynamic client registration — off unless `FLAIR_OAUTH_DCR_TOKEN` is set |
| `/OAuthAuthorize` | GET/POST | Authorization endpoint |
| `/OAuthToken` | POST | Token endpoint |
| `/.well-known/oauth-authorization-server` | GET | Authorization server metadata (RFC 8414) |
| `/.well-known/oauth-protected-resource` | GET | Protected resource metadata (RFC 9728) |
| `/OAuthMetadata` | GET | Alias of `/.well-known/oauth-authorization-server` |

Both well-known documents are public — RFC 8414 §3 and RFC 9728 §3 require them
to be retrievable without authentication — and are served with
`Access-Control-Allow-Origin: *` so browser-based MCP clients can read them.

The protected-resource document is also served at the RFC 9728 §3.1
path-appended URL `/.well-known/oauth-protected-resource/mcp`, which is the form
MCP clients construct from the resource identifier.

### Rate limiting

The OAuth endpoints and the OAuth-guarded `/mcp` surface are rate limited. This
is on by default; nothing needs configuring for it to apply.

| Surface | Default | Window | Keyed on |
|---------|---------|--------|----------|
| `/OAuthToken`, `/OAuthAuthorize`, `/OAuthRevoke` (one shared budget) | 30 | 60s | Caller address |
| `/OAuthRegister` | 5 | 300s | Caller address |
| `/mcp` | 120 | 60s | The verified token subject |

A rejected request gets `429` with a `Retry-After`, and a body that echoes
nothing back. The counter is consumed *before* any credential is examined, so a
`429` says nothing about the credential that came with it — a valid
authorization code and a garbage one get byte-identical responses once a bucket
is spent. No `RateLimit-*` headers are emitted on requests that are allowed;
publishing a live remaining-count on a credential endpoint is a pacing aid for
exactly the caller you don't want to help.

| Variable | Default | Meaning |
|----------|---------|---------|
| `FLAIR_RATE_LIMIT` | on | Set to `off` to disable rate limiting entirely. An unrecognised value leaves it **enabled**. |
| `FLAIR_OAUTH_RATE_LIMIT` | `30` | Requests per 60s for the token/authorize/revoke budget. |
| `FLAIR_OAUTH_REGISTER_RATE_LIMIT` | `5` | Registrations per 300s. |
| `FLAIR_MCP_RATE_LIMIT` | `120` | `/mcp` calls per 60s per token subject. |
| `FLAIR_TRUSTED_PROXY` | `0` | Number of trusted reverse-proxy hops in front of this instance. |

A limit set to `0`, a negative number, or anything non-numeric is refused and the
default is used, with a warning naming the variable — so a shell that expanded an
unset variable cannot silently switch the control off.

**`FLAIR_TRUSTED_PROXY` and NAT.** By default the key is the socket peer address
and `X-Forwarded-For` is ignored completely, because that header is caller-supplied:
an instance that honours it with no proxy in front can be bypassed by anyone
willing to vary a header. Set `FLAIR_TRUSTED_PROXY` to the number of proxies that
genuinely sit in front and append to `X-Forwarded-For`, and the key becomes the
entry those hops wrote (counted from the right — never the leftmost entry, which
the original caller controls). Keying on an address means a busy NAT shares one
budget; the defaults leave roughly two orders of magnitude of headroom over real
usage, and raising them is a one-variable change.

**This limiter is per node.** The counter lives in the serving process. On a
multi-node deployment the effective ceiling is the configured limit times the
number of nodes, and the counters reset when a component reloads. That is a
deliberate trade: a cluster-shared counter in a Harper table would make every
counted request a durable replicated write on an authentication hot path, which
is a worse denial-of-service shape than the one being defended against. The
control here bounds how fast a caller can guess against 256-bit secrets, and a
small constant multiplier does not change that. It does **not** defend against a
distributed botnet, and it is not a capacity control.

Every URL in every one of these documents derives from `FLAIR_PUBLIC_URL`,
falling back to the loopback bind address. **Set `FLAIR_PUBLIC_URL` on any
deployment reachable at something other than localhost** — otherwise the
documents are well-formed and every URL in them points at the *client's* own
localhost. See [deploying-on-fabric.md](deploying-on-fabric.md).

## XAA (Enterprise-Managed Authorization)

For organizations using an Identity Provider (IdP), XAA lets the IdP control who accesses Flair and with what scopes.

### How It Works

1. User authenticates with the organization's IdP (Google, Azure AD, Okta)
2. IdP issues an ID token (JWT) with user identity and group claims
3. Client sends the ID token to Flair's token endpoint using the `jwt-bearer` grant type
4. Flair validates the JWT signature, checks issuer/domain, maps to a Principal, and issues a scoped access token

```
POST /OAuthToken
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<id-token-from-idp>
```

### IdP Configuration

Register an IdP with the CLI:

```bash
flair idp add \
  --name "Google Workspace" \
  --issuer "https://accounts.google.com" \
  --jwks-uri "https://www.googleapis.com/oauth2/v3/certs" \
  --required-domain "yourcompany.com"
```

### Supported IdPs

| IdP | Issuer | Domain Claim |
|-----|--------|-------------|
| Google Workspace | `https://accounts.google.com` | `hd` (hosted domain) |
| Azure AD (Entra) | `https://login.microsoftonline.com/{tenant}/v2.0` | `tid` (tenant ID) |
| Okta / Auth0 | `https://{org}.okta.com` | Issuer-scoped |

### Scopes

| Scope | Description |
|-------|-------------|
| `memory:read` | Read memories and search |
| `memory:write` | Write and delete memories |
| `memory:admin` | Memory maintenance operations |
| `principal:read` | View principal list |
| `principal:admin` | Create/modify/disable principals |
| `connector:admin` | Manage OAuth clients and IdPs |

### JIT Provisioning

First-time IdP users are automatically created as `unverified` principals. An admin can promote them to `verified` or `admin` via:

```bash
flair principal promote <principal-id>
```

### CLI Reference

| Command | Description |
|---------|-------------|
| `flair idp add` | Register an IdP |
| `flair idp list` | List configured IdPs |
| `flair idp remove <id>` | Remove an IdP |
| `flair idp test <id>` | Test IdP connectivity |

## Web Admin

The web admin at `/AdminDashboard` provides a UI for managing:

- **Principals:** view, promote, disable agents and users
- **Connectors:** OAuth clients and active sessions
- **IdP:** enterprise identity provider configuration
- **Memory:** browse and search stored memories
- **Instance:** federation status, peer connections

Access requires admin-level authentication (Basic auth with the Harper admin password).
