# FLAIR-XAA: Enterprise-Managed Authorization

> MCP Enterprise-Managed Authorization (XAA) support for Flair, enabling corporate IdP-driven access control.

**Status:** Draft
**Depends on:** FLAIR-PRINCIPALS (§ 2 OAuth 2.1), FLAIR-CLI, FLAIR-WEB-ADMIN
**Audience:** 1.0 — Nathan using Flair at Harper

---

## § 1 Problem

Nathan uses Flair at Harper. Harper has corporate identity infrastructure (IdP, SSO). Without XAA, every person and agent at Harper who wants to use Flair must:

1. Get a Principal created manually by Nathan
2. Authenticate directly to Flair's OAuth server
3. Manage their own authorization lifecycle

This doesn't scale. It creates shadow IT: no centralized visibility, no policy enforcement, no automatic deprovisioning when someone leaves. XAA shifts authorization decisions to Harper's IdP so Flair participates in the enterprise identity fabric rather than standing apart from it.

## § 2 What XAA Is

MCP Enterprise-Managed Authorization (XAA) chains three OAuth standards:

```
User → Corporate SSO → ID Token
                         ↓
           IdP Policy Check (admin rules)
                         ↓
                      ID-JAG (signed JWT with policy decision)
                         ↓
           Flair Authorization Server validates ID-JAG
                         ↓
                   Access Token (scoped to IdP policy)
                         ↓
              Flair Resource Server (read/write memories)
```

**ID-JAG** (Identity Assertion JWT Authorization Grant) is the key artifact — a short-lived JWT issued by the enterprise IdP that encodes:
- Who the user is (`sub`)
- What they're allowed to do (`scope`)
- Which MCP server they're accessing (`resource`)
- Which client is requesting access (`client_id`)

The IdP evaluates organizational policies (group membership, role assignments, conditional access) before issuing the ID-JAG. Users never see a consent screen — the admin has already decided.

### Standards

| Standard | Role |
|---|---|
| OpenID Connect | User authenticates to MCP client via corporate SSO |
| RFC 8693 (Token Exchange) | Client exchanges ID Token for ID-JAG at IdP |
| RFC 7523 (JWT Profile) | Client exchanges ID-JAG for access token at Flair |
| RFC 9728 (Resource Indicators) | Client specifies target Flair instance as resource |

## § 3 Flair's Role

Flair is an **MCP Authorization Server** and **MCP Resource Server**. In XAA:

### 3.1 Discovery

Flair's `/.well-known/oauth-authorization-server` metadata declares XAA support:

```json
{
  "issuer": "https://flair.example.com",
  "token_endpoint": "https://flair.example.com/oauth/token",
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer"
  ],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "extensions_supported": [
    "io.modelcontextprotocol/enterprise-managed-authorization"
  ]
}
```

The `urn:ietf:params:oauth:grant-type:jwt-bearer` grant type is what clients use to exchange an ID-JAG for an access token (RFC 7523).

### 3.2 ID-JAG Validation

When a client presents an ID-JAG at `/oauth/token`, Flair validates:

1. **Signature** — Verify JWT signature against the IdP's JWKS endpoint (`idp.jwksUri`). Reject if signature doesn't match any published key.
2. **Issuer** — `iss` must match a configured trusted IdP (`idp.issuer`). Reject unknown issuers.
3. **Audience** — `aud` must match Flair's own issuer URL. Reject if mismatch.
4. **Resource** — `resource` must match Flair's canonical resource URI. Reject if it names a different MCP server.
5. **Expiry** — `exp` must be in the future. ID-JAGs are short-lived (typically 5 minutes).
6. **Client** — `client_id` must match the requesting client's registered client ID.
7. **Type** — JWT header `typ` must be `oauth-id-jag+jwt`.
8. **Domain** — If `requiredDomain` is set on the IdP config, the token's `hd` claim must match. Reject tokens from personal accounts (missing `hd`) or other organizations (wrong `hd`). This is the primary trust boundary for Google Workspace.

If all checks pass, Flair issues an access token scoped to the `scope` claim in the ID-JAG.

### 3.3 Principal Resolution

After validating the ID-JAG, Flair needs to map the IdP identity to a Principal:

```
ID-JAG.sub  →  Principal lookup by IdP credential
```

**JIT (Just-In-Time) Provisioning:** If no Principal exists for this IdP subject:

1. Create a new Principal with `kind: "human"`, `defaultTrustTier: "unverified"`
2. Add an IdP credential: `{ type: "idp", provider: "<idp-id>", subject: "<sub>", email: "<email>" }`
3. Copy display name from ID-JAG claims if available (`name`, `preferred_username`)
4. Log the auto-provisioning event for audit

**Existing Principal:** If a Principal already exists (matched by IdP credential), use it directly. The IdP's policy decision (scopes) applies for this session.

**Deprovisioning:** When an IdP removes a user, they can no longer obtain ID-JAGs. Their existing Flair refresh tokens continue to work until they expire. For immediate revocation, the admin uses `flair principal disable <id>` or the web admin UI.

### 3.4 Scope Mapping

The ID-JAG `scope` claim contains space-separated OAuth scopes. Flair defines these scopes for memory access:

| Scope | Grants |
|---|---|
| `memory:read` | Read memories (search, get, list) |
| `memory:write` | Write memories (store, update) |
| `memory:admin` | Delete memories, manage subjects, bulk operations |
| `principal:read` | View principal list and details |
| `principal:admin` | Create/modify/disable principals |
| `connector:read` | View connector configuration |
| `connector:admin` | Create/modify/delete connectors |

The IdP admin configures which scopes each user group gets. For example:
- Engineering team: `memory:read memory:write`
- Team leads: `memory:read memory:write memory:admin`
- IT admins: all scopes

If the ID-JAG contains scopes Flair doesn't recognize, they're silently ignored.

## § 4 IdP Configuration

### 4.1 CLI

```bash
# Register Google Workspace as the enterprise IdP
flair idp add \
  --name "Harper Corporate" \
  --issuer "https://accounts.google.com" \
  --jwks-uri "https://www.googleapis.com/oauth2/v3/certs" \
  --client-id "flair-production" \
  --required-domain "harper.io" \  # reject non-Harper Google accounts
  --jit-provision                  # auto-create principals for new IdP users

# List configured IdPs
flair idp list

# Remove an IdP (existing principals remain but can't re-authenticate via this IdP)
flair idp remove "Harper Corporate"

# Test IdP connectivity (fetches JWKS, validates TLS)
flair idp test "Harper Corporate"
```

### 4.2 Data Model

```typescript
interface IdpConfig {
  id: string;                    // stable UUID
  name: string;                  // display name ("Harper Corporate")
  issuer: string;                // must match ID-JAG `iss` (Google: "https://accounts.google.com")
  jwksUri: string;               // JWKS endpoint (Google: "https://www.googleapis.com/oauth2/v3/certs")
  clientId: string;              // Flair's client_id at this IdP
  requiredDomain?: string;       // if set, reject tokens without matching `hd` claim (Google Workspace domain)
  jitProvision: boolean;         // auto-create principals on first login
  defaultTrustTier: "unverified" | "corroborated";  // tier for JIT principals
  allowedScopes?: string[];      // restrict which scopes this IdP can grant (optional)
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Stored in Harper's configuration (not in Flair's memory store — this is infrastructure config, not knowledge).

### 4.3 Google Workspace Specifics

Harper uses Google Workspace as its IdP. Key integration details:

- **Issuer:** `https://accounts.google.com` (constant for all Google OIDC)
- **JWKS:** `https://www.googleapis.com/oauth2/v3/certs` (rotated frequently; caching with forced refresh on miss is critical)
- **`hd` claim:** Google ID tokens include a `hd` (hosted domain) claim for Workspace accounts. Flair validates `hd` matches `requiredDomain` to reject personal Gmail accounts. A missing `hd` claim (consumer Google account) is rejected when `requiredDomain` is set.
- **`email` claim:** Used for display and JIT principal naming. Google always includes `email` and `email_verified` in ID tokens.
- **`sub` claim:** Stable per-user identifier (numeric string). This is the durable key for principal credential matching — email addresses can change, `sub` cannot.
- **Google Admin Console:** Scope assignment and app access policies are managed in Google Workspace Admin > Security > API Controls. The Google admin controls which users can access Flair's OAuth client.

### 4.3 JWKS Caching

Flair caches the IdP's JWKS for performance:
- Cache TTL: 1 hour
- Force refresh on signature validation failure (key rotation)
- Background refresh 5 minutes before TTL expires
- If JWKS endpoint is unreachable, continue using cached keys for up to 24 hours (graceful degradation)

## § 5 Web Admin Integration

The web admin UI (FLAIR-WEB-ADMIN) adds:

### 5.1 `/admin/idp` — IdP Management Page

- List configured IdPs with status (connected/unreachable)
- Add/edit/remove IdP configurations
- Test connectivity button
- View last JWKS refresh timestamp

### 5.2 `/admin/principals` — Enhanced Principal View

For IdP-provisioned principals, show:
- IdP source badge ("Harper Corporate")
- IdP subject identifier
- Last IdP login timestamp
- JIT-provisioned flag

### 5.3 `/admin/audit` — Audit Log

XAA events to log:
- `idp.jag_validated` — ID-JAG successfully validated
- `idp.jag_rejected` — ID-JAG validation failed (with reason)
- `idp.principal_provisioned` — JIT principal created
- `idp.jwks_refreshed` — JWKS cache updated
- `idp.unreachable` — JWKS endpoint unreachable

## § 6 Token Lifecycle

### 6.1 Access Tokens

- Issued after ID-JAG validation
- Max lifetime: 1 hour (matches FLAIR-PRINCIPALS § 2)
- Scoped to the ID-JAG's `scope` claim
- Include `idp_sub` and `idp_iss` in token metadata for audit

### 6.2 Refresh Tokens

- Issued alongside access tokens
- Rotation on each use (FLAIR-PRINCIPALS § 2)
- Lifetime: configurable, default 7 days
- Revocable via `/oauth/revoke` or admin UI

### 6.3 Relationship to Direct Auth

XAA and direct auth (passkey/OAuth DCR) coexist:

| Auth Method | Who Uses It | Principal Source |
|---|---|---|
| WebAuthn passkey | Nathan (direct web login) | Manual principal |
| OAuth DCR (Claude redirect) | Nathan via Claude clients | Manual principal |
| XAA (ID-JAG) | Harper employees via corporate SSO | JIT or manual principal |
| Bearer token | Agents (Kern, Sherlock, etc.) | Manual principal |

A single Principal can have multiple credential types. If Nathan is both a direct admin and an IdP user, his Principal has both a passkey credential and an IdP credential.

## § 7 Security Considerations

### 7.1 IdP Trust

Flair trusts the IdP's policy decision completely. If the IdP says "user X gets `memory:admin`", Flair grants it. This is by design — the enterprise admin owns the policy. Flair's role is enforcement, not policy evaluation.

**Implication:** A compromised IdP can grant arbitrary access to Flair. Mitigations:
- `allowedScopes` on IdpConfig can cap what any IdP-sourced token can do (defense in depth)
- Audit logging of all ID-JAG validations
- Admin notification on unusual scope grants

### 7.2 ID-JAG Replay

ID-JAGs are short-lived (5 min) and include `jti` (unique ID). Flair maintains a `jti` replay cache (in-memory, TTL = ID-JAG max lifetime + clock skew allowance of 30 seconds). A replayed ID-JAG is rejected.

### 7.3 Clock Skew

Allow up to 30 seconds of clock skew when validating `exp` and `iat` claims. Configurable via `flair config set idp.clockSkewSeconds`.

### 7.4 Scope Escalation

The ID-JAG's scopes are a ceiling — Flair never grants more than what the IdP authorized. If the client requests additional scopes at the token endpoint, Flair intersects them with the ID-JAG scopes (narrower wins).

### 7.5 Multi-IdP

1.0 supports a single IdP configuration. Multi-IdP (e.g., Harper corporate + contractor IdP) requires matching the ID-JAG's `iss` to the correct IdP config. The validation path already supports this — `iss` lookup is by issuer URL, not by position.

## § 8 1.0 Scope

### In Scope

- Single IdP configuration via CLI and web admin
- ID-JAG validation at `/oauth/token` (RFC 7523 grant type)
- JIT principal provisioning with `defaultTrustTier: "unverified"`
- Scope-based access control (read/write/admin per resource type)
- JWKS caching with graceful degradation
- Audit logging of XAA events
- `jti` replay prevention
- Discovery metadata advertising XAA support

### Not In Scope (Post-1.0)

- **Multi-IdP** — single IdP per instance for 1.0
- **IdP-driven deprovisioning webhook** (SCIM) — manual disable for now
- **Fine-grained resource authorization** (per-subject, per-memory-type) — scopes are coarse-grained in 1.0
- **Admin consent UI at the IdP** — IdP-side configuration is the admin's responsibility; Flair doesn't provide an admin consent endpoint
- **Cross-org federation with XAA** — IdP trust is instance-local; federated instances don't inherit IdP trust
- **Step-up authentication** — all scopes granted at login time, no re-auth for sensitive operations

## § 9 Implementation Notes

### Harper Deployment

On Harper (Fabric), the IdP configuration is stored alongside other Flair instance configuration:
- `harper set_configuration` for IdP config (issuer, JWKS URI, client ID)
- JWKS cache is in-memory (lost on restart, rebuilt from IdP)
- Audit events go to Harper's structured logging (available via Fabric console)

### Local Development

For local Flair instances (rockit), XAA is optional. If no IdP is configured, the `/oauth/token` endpoint only accepts `authorization_code` and `refresh_token` grants — the `jwt-bearer` grant type is disabled. This means local instances work exactly as FLAIR-PRINCIPALS § 2 describes, with no XAA overhead.

### Testing

```bash
# Verify XAA is configured
flair idp test "Harper Corporate"

# Generate a test ID-JAG (development only, uses a local signing key)
flair idp test-jag --sub "nathan@harper.io" --scope "memory:read memory:write"

# Exchange test ID-JAG for access token
curl -X POST https://flair.local/oauth/token \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "assertion=<id-jag-jwt>"
```

## § 10 IdP Profiles

The core validation path (§ 3.2) is IdP-agnostic — any OIDC-compliant IdP works. This section documents provider-specific details for the three IdPs most likely to appear in Flair deployments.

### 10.1 Google Workspace

Harper's IdP. See § 4.3 for full details.

| Field | Value |
|---|---|
| Issuer | `https://accounts.google.com` |
| JWKS | `https://www.googleapis.com/oauth2/v3/certs` |
| Domain claim | `hd` (hosted domain) |
| Stable user ID | `sub` (numeric string, immutable) |
| Admin console | Google Workspace Admin > Security > API Controls |
| XAA support | Native OIDC; no dedicated XAA/Cross App Access extension |

**Domain restriction:** Set `requiredDomain` to the Workspace domain (e.g., `harper.io`). Flair rejects tokens with missing or mismatched `hd` claim, preventing personal Gmail accounts from authenticating.

### 10.2 Azure AD (Entra ID)

| Field | Value |
|---|---|
| Issuer | `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| JWKS | `https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys` |
| Domain claim | `tid` (tenant ID, UUID) |
| Stable user ID | `oid` (object ID, UUID — preferred over `sub` which varies per client) |
| Admin console | Entra ID > Enterprise Applications > App registrations |
| XAA support | App roles and group claims via manifest; admin consent flow native |

**Domain restriction:** Set `requiredDomain` to the Azure tenant ID. Flair validates the `tid` claim matches. Multi-tenant Azure apps (where `tid` varies) are not supported in 1.0 — single tenant only.

**Azure-specific note:** Azure ID tokens can include `groups` and `roles` claims if configured in the app manifest. These could map to Flair scopes directly in a future version, bypassing the need for IdP-side scope assignment.

### 10.3 Okta

| Field | Value |
|---|---|
| Issuer | `https://{org}.okta.com` or `https://{org}.okta.com/oauth2/{auth-server-id}` |
| JWKS | `https://{org}.okta.com/oauth2/v1/keys` |
| Domain claim | Issuer URL is org-scoped (no separate domain claim needed) |
| Stable user ID | `sub` (Okta user ID) |
| Admin console | Okta Admin > Applications > API > Authorization Servers |
| XAA support | Native — Okta built the [reference implementation](https://github.com/oktadev/okta-cross-app-access-mcp) for MCP Cross App Access |

**Domain restriction:** Not needed — the issuer URL itself is organization-scoped. A token from `acme.okta.com` can't impersonate one from `harper.okta.com`.

**Okta-specific note:** Okta has the most mature XAA support of any IdP. Their Cross App Access implementation handles the full ID-JAG flow natively, including admin policy configuration via Authorization Server policies and rules. If a customer is on Okta, the XAA integration is nearly turnkey.

### 10.4 Generalizing `requiredDomain`

The `requiredDomain` field on `IdpConfig` maps to different claims per provider:

| IdP | Claim checked | Example value |
|---|---|---|
| Google | `hd` | `harper.io` |
| Azure AD | `tid` | `a1b2c3d4-...` (tenant UUID) |
| Okta | (issuer URL) | N/A — inherently scoped |

If `requiredDomain` is set and the provider doesn't include the expected claim (e.g., a consumer Google account with no `hd`), the token is rejected. This is the primary trust boundary preventing cross-org impersonation.
