# Authentication & Authorization

Flair supports three authentication methods, from simplest to most enterprise-ready.

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
