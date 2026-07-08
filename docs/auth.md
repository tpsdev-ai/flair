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

## OAuth 2.1

Flair includes a built-in OAuth 2.1 authorization server for client integrations (e.g., Claude connecting to Flair as an MCP server).

### Dynamic Client Registration

Clients register automatically on first connection:

```
POST /OAuthRegister
Content-Type: application/json

{
  "client_name": "Claude Desktop",
  "redirect_uris": ["http://localhost:3000/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Returns `client_id` and `client_secret` (if applicable).

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
| `/OAuthRegister` | POST | Dynamic client registration |
| `/OAuthAuthorize` | GET/POST | Authorization endpoint |
| `/OAuthToken` | POST | Token endpoint |
| `/.well-known/oauth-authorization-server` | GET | Server metadata |

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
