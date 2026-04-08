# Flair Principals

## Status
- **Owner:** Flint
- **Priority:** P1 — foundational to 1.0
- **Context:** Design session with Nathan, 2026-04-07; K&S review 2026-04-08
- **Reviewers:** Kern (architecture, approved with reservations), Sherlock (security, approved)
- **Composes with:** MEMORY-MODEL-V2, FLAIR-FEDERATION, FLAIR-WEB-ADMIN

## Revision Notes — 2026-04-08

Changes since the 2026-04-07 draft, based on K&S review and Nathan direction:

- **Trust tier enum simplified to 3 tiers.** Dropped `battle-tested`. Time is not a trust signal (long-game attacks make passive trust farmable). Aligns with companion revision to MEMORY-MODEL-V2. See Section 1 and referenced MEMORY-MODEL-V2 § 3.
- **Invited human principals default to `unverified`**, not `corroborated`. Resolved in Kern's favor. Rationale: Sherlock suggested `corroborated`, Kern suggested `unverified`; Kern is correct. `corroborated` is a tier representing confirmed consensus from multiple sources, not a middle default. An invited human has earned no consensus yet.
- **Added `runtime` field to Principal** per Nathan's "Flair is SSOT" directive. Other tooling (TPS mail, etc.) consults Flair to discover how to reach an agent.
- **Hardcode `claude.com/api/mcp/auth_callback` as the only permitted OAuth redirect URI for DCR clients**, per Sherlock. Open DCR with arbitrary redirect URIs is an impersonation vector. If support for additional clients is needed later, admin allowlist, not open DCR.
- **Accept self-attestation for WebAuthn**, per Sherlock, with the trade-off documented. Strict attestation breaks iCloud Keychain, 1Password, Bitwarden — the actual ways humans use passkeys. The security loss is bounded and documented.
- **Recovery code escrow rejected**, per K&S agreement. The recovery path for "lost all passkeys in standalone hosted" is a fresh token issued via the Fabric deployment console (or equivalent infrastructure access). No static credentials, no paper codes.
- **Single Principal per human across all Claude clients confirmed**, per Sherlock. OAuth session tracks the source client for audit; the underlying Principal is shared.
- **Server-held Ed25519 key for humans — threat accepted**, per Sherlock. Mitigation: HSM-backed storage if Fabric supports it; encrypted-at-rest otherwise; off-site encrypted backups.
- **Bearer token format `flair_at_<32 random bytes base62>` confirmed**, per Sherlock.
- **Added forward reference to FLAIR-FEDERATION §** Signature-to-Principal Binding, per Kern. Receiving Flair instance must verify every record's Ed25519 signature matches the `publicKey` registered to the claimed `principalId`, or reject. A compromised peer cannot re-sign records under another principal's identity. This is a federation-layer requirement but referenced here because it justifies the Principal identity model.
- **Sherlock's SOUL.md updated** with explicit trust-decision rules, "show your work" ritual, and "calibration against Kern" section. Time removed as a trust signal from his heuristics. Separate change, not in this spec.

## Summary

Flair today only knows about agents — Ed25519-keyed identities scoped to AI agents like Flint, Kern, Anvil. There is no concept of a human user. Nathan exists only as a string referenced inside agent memories ("Nathan said X").

This spec generalizes Agent into Principal with `kind: "human" | "agent"`, adds passkey/WebAuthn authentication for humans, adds an OAuth 2.1 server in front of Flair so Claude clients (Code, Desktop, iOS, web) can connect, and keeps the existing Ed25519 + bearer token paths for non-Claude agents. Both authentication paths land at the same Principal record and the same memory namespace.

A Principal is the unit of identity for everything in Flair: who wrote a memory, who owns a credential, who an OAuth session represents, who a sync operation is acting on behalf of.

---

## 1. Principal Data Model

### Schema

```typescript
interface Principal {
  id: string;                    // "usr_nathan_a7f3" or "agent_flint"
  kind: "human" | "agent";
  displayName: string;
  createdAt: string;
  status: "active" | "deactivated";

  // Cryptographic identity (always present, used for memory provenance)
  publicKey: string;             // Ed25519 public key
  // Private key handling differs by kind — see Section 2

  // Memory namespace
  memoryNamespace: string;       // typically equals id
  subjects: string[];            // soul-level subject interests

  // Trust (3 tiers, time is never a signal — see MEMORY-MODEL-V2 § 3)
  defaultTrustTier: "endorsed" | "corroborated" | "unverified";
  // Admin humans (the claimer of the instance) default to "endorsed".
  // Invited humans default to "unverified" until the admin promotes them.
  // Agents default to "unverified" until corroborated or endorsed.

  // Runtime — how external tools reach this principal
  // Humans are typically null (they authenticate on demand via OAuth/passkey).
  // Agents declare how they can be reached for programmatic delivery.
  // SSOT: Flair. Other tools (TPS mail, etc.) consult this field to route messages.
  runtime?: "openclaw" | "claude-code" | "headless" | "external" | null;
  runtimeEndpoint?: string;      // e.g., openclaw gateway URL, HTTP callback, etc.

  // Admin flag — admin principals can create other principals and promote trust tiers
  admin: boolean;

  // Credentials (auth surfaces, not the same as the Ed25519 keypair)
  credentials: Credential[];

  // Metadata
  metadata: Record<string, unknown>;
}

interface Credential {
  id: string;                    // "cred_a7f3"
  kind: "webauthn" | "bearer-token" | "ed25519";
  label: string;                 // "iPhone 16 Pro", "MacBook Pro", "OpenClaw plugin"
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "revoked";

  // Kind-specific data
  webauthn?: {
    credentialId: string;        // base64url
    publicKey: string;           // COSE key
    aaguid: string;              // authenticator identifier
    transports: string[];        // ["internal", "hybrid", "usb"]
    counter: number;
  };

  bearerToken?: {
    tokenHash: string;           // never store the token itself
    prefix: string;              // first 8 chars for identification
  };

  ed25519?: {
    publicKey: string;           // duplicates Principal.publicKey for the primary key,
                                 // separate entry for additional device keys
  };
}
```

### Identity vs Credential

A Principal has **one cryptographic identity** (the Ed25519 keypair) that signs memories — this is the provenance layer.

A Principal can have **many credentials** that authenticate API access. A credential is "how do you prove you are this Principal right now"; the Ed25519 keypair is "how do we attribute records to you in the data layer."

For agents, the credential and the identity are typically the same Ed25519 key (the agent signs API requests with the same key it signs memories with). For humans, the identity Ed25519 key lives only on the Flair instance — the human never holds it. Their credentials are passkeys (WebAuthn) and OAuth sessions, which Flair maps to the human's Principal and uses the server-held Ed25519 key to sign on their behalf.

This separation matters because:
1. Humans can't reasonably manage Ed25519 keys themselves — passkeys are the only realistic credential for them
2. Memory provenance must be cryptographically verifiable inside Flair's data layer regardless of how the write was authenticated
3. Cross-instance sync (FLAIR-FEDERATION) replicates signed records — the signature must be by a key Flair controls so other instances can verify

### Generalizing the existing Agent table

The current `Agent` table becomes `Principal` with a kind discriminator. Migration: every existing Agent row becomes a Principal row with `kind: "agent"`, `defaultTrustTier: "unverified"`, and a single Credential of kind `ed25519` referencing their existing key. No data loss.

**On trust tier assignment during migration:** earlier drafts of this spec proposed defaulting existing agents to `battle-tested` ("they have a track record"). That tier has been removed; time-based trust is not a signal (see MEMORY-MODEL-V2 § 3 and Revision Notes). Existing agents start at `unverified` and must be promoted explicitly — either by Nathan endorsing specific agents to `endorsed`, or via distillation corroborating their outputs. The spec treats migration as a restart of the trust graph, not a carry-over. This is a feature: passive trust accrued over months under the old model was never earned through an active signal.

---

## 2. Authentication Surfaces

Flair must accept four authentication methods, each landing at a Principal:

| Method | Used by | Surface |
|---|---|---|
| Ed25519 signing | Existing agents (Flint, Kern, Anvil, OpenClaw plugins) | Local HTTP, remote HTTP |
| Bearer token | Custom agents, CLI, scripts, anything that can't sign | Local HTTP, remote HTTP |
| WebAuthn (passkey) | Humans logging in directly via web | Web UI only |
| OAuth 2.1 | Claude Code, Desktop, iOS, web (and future MCP clients) | Remote MCP transport |

All four authenticate to the same Principal records. The credential type doesn't change what the Principal is allowed to do — it changes how identity is established.

### Ed25519 Signing (existing, unchanged)

Today's model. Agent generates a keypair, registers the public key with Flair, signs every API request with a timestamp + nonce. Flair verifies. Stays exactly as it is for backward compatibility and for any client that wants the strongest auth.

### Bearer Tokens

Already specified in MEMORY-MODEL-V2 § 4. Recap:

```bash
flair credential create agent_anvil --label "OpenClaw plugin"
# outputs:
#   Token: flair_at_aB3xK9...   (shown once, never again)
#   Add to your client config.
```

Tokens are stored as hashes server-side, sent in `Authorization: Bearer <token>` header, mapped to a Principal on every request. Revocable per-credential. Required transport: TLS for any remote connection.

### WebAuthn / Passkeys

The primary authentication path for humans. Used both for direct web login and as the credential backing OAuth sessions.

Registration flow (covered in Section 5).

Login flow:
1. User opens Flair web UI → presented with login page
2. Page calls `navigator.credentials.get()` with a server-issued challenge
3. Authenticator (Touch ID, Face ID, security key, password manager) prompts user
4. Browser returns assertion → POSTed to `/auth/webauthn/verify`
5. Server verifies signature against stored credential public key, checks counter, returns session cookie
6. Session cookie authenticates subsequent web requests

No password ever exists. No password reset. No magic link. New devices use cross-device WebAuthn (Section 5) or get added by an already-logged-in session.

### OAuth 2.1 Server

This is the new piece. Required because Anthropic only supports OAuth or authless for remote MCP custom connectors. To work with Claude clients, Flair must speak OAuth.

Endpoints:
- `GET /oauth/authorize` — auth code grant entry point. Renders consent screen.
- `POST /oauth/token` — token exchange (auth code → access + refresh tokens)
- `POST /oauth/register` — Dynamic Client Registration (RFC 7591)
- `GET /.well-known/oauth-authorization-server` — discovery metadata
- `POST /oauth/revoke` — token revocation (RFC 7009)
- `POST /oauth/introspect` — token introspection (RFC 7662, optional)

Flow when adding Flair as a custom connector in claude.ai:
1. Nathan adds `https://flair.lifestylelab.io` as a custom connector
2. Claude's backend hits `/.well-known/oauth-authorization-server` to discover endpoints
3. Claude registers itself via `/oauth/register` (DCR), getting back a client_id
4. Claude redirects Nathan's browser to `/oauth/authorize` with PKCE
5. Flair shows login (if not already logged in) → consent screen ("Claude wants to access your Flair memories")
6. Nathan approves → Flair issues an authorization code → redirects to `https://claude.com/api/mcp/auth_callback`
7. Claude's backend exchanges the code at `/oauth/token` for access + refresh tokens
8. Tokens are stored by Anthropic, synced across all of Nathan's Claude clients (mobile, desktop, web)
9. Every MCP request from any Claude client carries the access token; Flair maps it to Nathan's Principal

The OAuth session represents the human Principal. When Claude writes a memory through this session, the memory is signed by Flair using Nathan's Ed25519 identity key (server-held), and the credential record on the memory references the OAuth session for audit.

### Why not OAuth for everything

Bearer tokens and Ed25519 stay first-class because:
- OAuth requires a browser-capable client. CLI agents and headless services can't easily go through an authorize flow.
- DCR registers an OAuth client with full consent flow — overkill for a one-time CLI provisioning step.
- Ed25519 signing is stronger than OAuth bearer tokens (no shared secrets in transit) and we want to keep that path for agents that can use it.

Each method has its place. We support all four because cutting any of them creates a worse experience for some legitimate client.

---

## 3. Principal CRUD

### Create

```bash
# CLI (cold start, recovery, scripted provisioning)
flair principal create --kind human --display-name "Nathan"
flair principal create --kind agent --display-name "anvil"
```

CLI is required for creating the very first principal on a fresh Flair instance because there's nobody to authenticate yet. After that, principals can also be created from the web UI by an already-authenticated admin principal.

Web UI: an authenticated admin (a human Principal with admin flag) can create new agent principals and provision their credentials. Cannot create new human principals from the web UI directly — humans go through a passkey registration flow that establishes consent and binding to a real authenticator (Section 5).

### Read

```bash
flair principal list
flair principal show usr_nathan_a7f3
flair principal show --kind agent
```

Web UI: principals page lists all principals in the instance, filterable by kind and status. Detail view shows credentials, recent activity, memory count.

### Update

```bash
flair principal update usr_nathan_a7f3 --display-name "Nathan H."
flair principal update agent_anvil --add-subject deployment
flair principal deactivate agent_old-bot
```

Deactivating a principal:
- Disables all credentials immediately
- Active sessions are revoked
- Existing memories remain attributed to the deactivated principal (provenance preserved)
- Memory writes from the deactivated principal are blocked
- Reactivation possible later

### Delete

There is no delete. Deactivation is the strongest "remove" operation because deletion would orphan memories (which retain `agentId` references) and break the provenance chain. If a principal needs to be permanently expunged for legal reasons (right to be forgotten), there's a separate `flair principal purge <id>` operation that:
1. Anonymizes the Principal record (removes display name, credentials, public key)
2. Leaves the ID in place so memory references still resolve
3. Tags the principal as `purged: true` in metadata
4. Logs the action

This is intentionally rarer and harder than deactivation.

---

## 4. Credential Management

### Add Credential

Each principal can have multiple credentials. Adding a credential is the device-pairing operation.

CLI (works for any kind):
```bash
flair credential create usr_nathan_a7f3 --kind webauthn --label "iPhone 16 Pro"
# outputs a one-time setup URL valid for 10 minutes:
#   https://flair.lifestylelab.io/setup/cred_a7f3?token=<one-time-token>
```

The user opens that URL on the target device, completes WebAuthn registration via FaceID/TouchID, and the credential is bound to the principal.

```bash
flair credential create agent_anvil --kind bearer-token --label "OpenClaw plugin"
# outputs the token once:
#   Token: flair_at_aB3xK9... (copy now, will not be shown again)
```

Inline web flow (already-authenticated principal adds a new credential to themselves):
1. Logged-in principal goes to Settings → Credentials → Add new device
2. Page presents: "Use this device" or "Use a different device"
3. "Use this device" → triggers WebAuthn registration ceremony in the current browser
4. "Use a different device" → presents a QR code (cross-device WebAuthn flow). User scans on target device, completes registration there over BLE/cloud relay. Credential gets registered against the principal.
5. New credential appears in the list

### List Credentials

```bash
flair credential list usr_nathan_a7f3
# id          kind       label              created     last_used   status
# cred_a7f3   webauthn   iPhone 16 Pro      2026-04-07  2026-04-07  active
# cred_b8k2   webauthn   MacBook Pro        2026-04-07  2026-04-07  active
# cred_c1m5   bearer-token  OpenClaw plugin 2026-04-07  2026-04-06  active
```

Web UI: Settings → Credentials shows the same list with friendlier formatting and a "revoke" button per credential.

### Revoke Credential

```bash
flair credential revoke cred_b8k2
```

Web UI: revoke button per credential, confirmation dialog ("This will sign you out of MacBook Pro and prevent it from connecting until you re-register. Continue?").

Revocation is immediate. Active sessions tied to the credential are killed. Future requests from the credential are rejected.

If a principal revokes their last credential, the principal is auto-deactivated. CLI is the only path back in.

### Cross-Device WebAuthn (the QR flow)

This is the only acceptable answer to "how do I add my Windows laptop when my passkeys are in iCloud Keychain." It's natively supported by browsers on iOS/macOS/Android/Chrome.

Flow:
1. On Windows laptop: open Flair, click "Add a new device" or hit a registration page
2. Browser shows: "Use a phone, tablet, or security key" → QR code
3. On iPhone: open camera, scan QR
4. iPhone confirms: "Sign in to flair.lifestylelab.io?" → FaceID
5. iPhone signs the challenge over BLE/internet relay
6. Windows browser receives the signed assertion → completes WebAuthn registration ceremony for a NEW credential bound to the laptop's local TPM/Windows Hello
7. Both devices now have credentials for the same principal

This is one credential being used to authorize the creation of another credential on a new device. WebAuthn calls this "cross-device authentication."

---

## 5. The Cold Start Problem (First Principal)

The hardest case: fresh Flair instance, zero principals, nobody to authenticate. How does the first human get in?

### Federated topology (rockit + hosted)

Easier case. Nathan has CLI on rockit:

```bash
# On rockit
flair principal create --kind human --display-name "Nathan"
# → Created principal usr_nathan_a7f3
# → Open this URL on the device you want to register first:
#   https://flair.lifestylelab.io/setup/usr_nathan_a7f3?token=<one-time>
#   Token expires in 15 minutes.
```

Nathan opens the URL on his iPhone, FaceID prompt creates a passkey, the credential is bound to his principal. Subsequent device adds use the inline web flow (Section 4) authenticated by the now-existing iPhone passkey.

### Standalone hosted topology

Harder case. No CLI access — Flair is on Harper Fabric, Nathan only has the deployment console.

Bootstrap flow:
1. Nathan deploys Flair to Fabric
2. On first boot, Flair detects "no principals exist" state and generates a one-time **claim token**
3. Flair logs the claim token to stdout (which Fabric surfaces in its console) AND prints the claim URL
4. Nathan reads the claim URL from Fabric's console: `https://flair.lifestylelab.io/claim/<token>`
5. Nathan opens the URL in any browser
6. Claim page: "Claim this Flair instance" → display name field → "Create my account"
7. Submission triggers WebAuthn registration ceremony — passkey created on the current device
8. First Principal is created with `kind: "human"` and `admin: true`. Claim token is consumed.
9. Subsequent visits to `/claim` redirect to login

This is the "claim" pattern used by services like Sentry, GitLab, and Vault for initial admin setup. It works because:
- The claim token is high-entropy and only valid until consumed
- The token is delivered through a channel only the deployer has access to (deployment console)
- After claim, the endpoint is permanently disabled for that instance

If multiple principals will exist (Nathan + a teammate), the claim flow only creates the first one. Subsequent humans are invited by the admin via the web UI's "Invite a person" flow, which generates per-invite one-time URLs and emails them (or shares them out-of-band) to the new user.

### Recovery: Lost All Credentials

The hardest recovery case. Nathan's iPhone is destroyed, MacBook stolen, all passkeys gone, no way to log in.

**Federated topology:** rockit CLI is the trust root. Nathan runs `flair credential create usr_nathan_a7f3 --kind webauthn --label "Replacement iPhone"` from rockit, gets a setup URL, registers a new passkey on a new device. Done. The trust root is "physical/SSH access to rockit."

**Standalone hosted topology:** harder. There's no CLI. Options:
1. **Nuke and re-claim.** Wipe the Fabric deployment, redeploy, claim token issued, register new passkey, restore data from backup. Heavy but works.
2. **Recovery code escrow.** At first claim, Flair generates a one-time recovery code shown to Nathan. If he stores it securely (1Password, paper in a safe), he can use it later via `/recover/<code>` to register a new credential. Open question for Sherlock (briefed): is escrow acceptable, or does it weaken the threat model too much?
3. **Out-of-band recovery via Fabric console.** Nathan triggers a recovery operation from the Fabric deployment console (e.g., setting an env var), which causes Flair to generate a fresh one-time recovery token at next boot. Reuses the claim mechanism. This is my preferred answer because it inherits the trust boundary of "access to the deployment console."

I'll bias toward option 3 in the spec and note option 2 as a Sherlock-decision.

---

## 6. UX Flows (Nathan-Grade)

This section is the part that prevents shipping a functional-but-clunky product. It is in scope for the spec because Nathan will evaluate Flair through a consumer lens.

### Flow 1: First-Time Standalone Hosted Setup

**State:** Nathan has just deployed Flair to Harper Fabric. He's looking at the Fabric console.

1. **Fabric console shows:**
   ```
   [INFO] Flair started — instance ID: flair_h82kx9
   [INFO] No principals exist. Claim this instance:
   [INFO]   https://flair.lifestylelab.io/claim/9f3a-b7c2-1d4e-8a5f
   [INFO]   This URL expires in 1 hour. After claim, this endpoint disables permanently.
   ```

2. **Nathan opens the URL on his iPhone.**

3. **Claim page:**
   - Headline: "Welcome to Flair"
   - Subhead: "Set up the account you'll use across all your devices"
   - Single field: "Your name" (defaulted to "Nathan" if Flair can guess from environment, otherwise blank)
   - Button: "Continue with passkey"
   - Footer: small "What's a passkey?" link → modal explanation in plain language

4. **Tap Continue → FaceID prompt** ("flair.lifestylelab.io wants to save a passkey")

5. **Success page:**
   - Big checkmark
   - "You're in, Nathan. Your account is ready."
   - Two buttons:
     - "Connect Claude on this device" → guides through claude.ai → Settings → Connectors → Add Custom Connector
     - "I'll do that later"
   - Small footer: "If you ever lose all your devices, you can recover access via your deployment console." → link to a short explainer page describing the Fabric recovery flow.

6. **No recovery code offered.** Recovery is specifically *not* via a printable code or escrowed secret — that was an earlier draft. The only recovery path is regenerating a one-time setup URL via the deployment console (Fabric), which requires infrastructure access. This is stronger than a code stored anywhere and better aligned with "passkey or nothing."

**Anti-goals (Nathan would hate):**
- Multi-step wizard with progress dots ("Step 1 of 5")
- Email verification before you can use it
- Required password as a fallback "just in case"
- Long terms-of-service acceptance gate
- Mandatory phone number
- "Choose a username" — display name is enough, ID is generated

### Flow 2: Adding Claude iOS After Initial Setup

**State:** Nathan has a Flair principal, registered via passkey, now wants to use Claude iOS to read/write his memories.

Constraint: per Anthropic's docs, custom connectors must be added on **claude.ai** (web), then sync to mobile.

1. **On Mac/iPad/iPhone browser:** Nathan goes to `claude.ai → Settings → Connectors → Add Custom Connector`
2. **Claude.ai prompts:** name + URL. Nathan enters "My Flair" and `https://flair.lifestylelab.io`
3. **Claude.ai backend** hits `/.well-known/oauth-authorization-server`, registers a client via DCR, opens an authorization redirect
4. **Nathan's browser** lands on Flair's `/oauth/authorize`:
   - Login required → WebAuthn prompt (FaceID), since he's not logged in yet on this browser
   - Authenticated → consent screen:
     - "Claude wants to access your Flair memories"
     - List of scopes in plain English: "Read your memories, write new memories on your behalf, manage memory metadata"
     - Two buttons: "Approve" (primary) and "Cancel"
5. **Approve** → redirects to `claude.com/api/mcp/auth_callback` with auth code
6. **Claude.ai** exchanges the code, stores the tokens
7. **Connector appears** in the connector list, status: connected
8. **On iPhone Claude app:** the connector is already there because Anthropic syncs across devices. Nathan opens any chat, asks "What's in my memory about the Flair launch?" — works.

**Anti-goals:**
- Manual paste of a long token into the iOS app (impossible per Anthropic's design, but worth stating: we don't try to work around it)
- Re-authenticating per device
- Telling Nathan "you have to log into Flair on each device first"
- Showing scope strings in raw OAuth form ("memories:read memories:write memories:admin")

### Flow 3: Adding the MacBook Pro (Cross-Device WebAuthn)

**State:** Nathan has been using Flair on iPhone, now wants to access the web UI from his MacBook for the first time. iCloud Keychain has already synced his iPhone passkey to Mac, so this is actually the trivial case for him — but the flow needs to work for non-Apple cases too.

Trivial case (synced passkey present):
1. Nathan opens `https://flair.lifestylelab.io` on MacBook
2. Login page → "Use a passkey"
3. macOS prompts: "Use Touch ID to sign in?" — passkey is already there
4. Touch ID → logged in

Non-trivial case (no synced passkey, e.g., adding a Windows laptop):
1. On Windows laptop: open Flair, login page → "Use a passkey"
2. Browser: "No passkey for this site. Use a phone or security key?" → QR code
3. On iPhone: open camera, scan QR → "Sign in to flair.lifestylelab.io?" → FaceID
4. Bluetooth/cloud relay carries the signed assertion to Windows browser
5. Windows browser is logged in
6. Flair detects: "this device doesn't have a local credential" → offers "Save a passkey to this device for next time?"
7. Nathan agrees → Windows Hello creates a local credential bound to his principal

**Anti-goals:**
- Forcing the QR flow for Apple-synced passkeys (use the local one if it's there)
- Not offering to save a local credential after cross-device sign-in
- Showing the WebAuthn details to the user (challenge, attestation, AAGUID)

### Flow 4: Revoking a Stolen Device

**State:** Nathan's MacBook is stolen. He's on his iPhone, logged in.

1. Settings → Devices → list of credentials
2. MacBook Pro entry → "Revoke" button
3. Confirmation modal: "Revoke MacBook Pro? This signs out the device and deletes its passkey from Flair. You can re-register it later if you recover it."
4. Confirm → credential disabled, success toast: "MacBook Pro revoked"
5. Flair separately invalidates any active OAuth tokens that were issued to a Claude client running on that device, if we can identify them by `lastClientFingerprint` metadata

**Anti-goals:**
- Confirmation requires re-entering passkey ("type your password to confirm" — there is no password)
- Vague success message ("Operation completed")
- Burying device management three menus deep

---

## 7. CLI Reference

```bash
# Principals
flair principal create [--kind human|agent] [--display-name <name>]
flair principal list [--kind human|agent] [--status active|deactivated]
flair principal show <principal-id>
flair principal update <principal-id> [--display-name <name>] [--add-subject <s>] [--remove-subject <s>]
flair principal deactivate <principal-id>
flair principal reactivate <principal-id>
flair principal purge <principal-id>          # legal-grade removal, anonymizes record

# Credentials
flair credential create <principal-id> --kind webauthn|bearer-token|ed25519 --label <label>
flair credential list <principal-id>
flair credential show <credential-id>
flair credential revoke <credential-id>

# Auth/recovery
flair recover <principal-id>                  # generates a one-time recovery URL
flair admin add <principal-id>                # promotes a principal to admin
flair admin remove <principal-id>
```

All CLI commands write through the same Principal API the web UI uses. CLI is not a backdoor — it's authenticated via a special "local CLI" credential auto-provisioned for the Unix user running the Flair process. Removing that credential disables CLI access until reauthorized.

---

## 8. Migration from Current Agent-Only Model

### Schema migration

1. Rename `Agent` table to `Principal`
2. Add columns: `kind`, `displayName`, `status`, `defaultTrustTier`, `subjects`, `metadata`
3. Backfill: `kind = "agent"`, `displayName = id`, `status = "active"`, `defaultTrustTier = "unverified"` for all existing rows (see § 1 — "time is not a trust signal" — migration is a restart of the trust graph, not a carry-over)
4. Create `Credential` table
5. For each existing Agent, create a Credential row of kind `ed25519` with the agent's existing public key, label `"Primary key (migrated)"`
6. Add a `human` Principal for Nathan via `flair principal create --kind human --display-name "Nathan"` as the first post-migration step
7. Existing memories continue to reference principals by ID — no memory data changes
8. Reattribute any "Nathan said X" memories that were stored as Flint-authored to be Nathan-authored if and only if they're plainly user statements; this is a one-time backfill script with manual review

### API migration

- All existing `/Agent` endpoints get `/Principal` aliases. `/Agent` endpoints stay for one minor version, then redirect, then remove.
- SDK clients (`flair-client`, `openclaw-flair`, etc.) get a major version bump that switches from `agentId` to `principalId` in their request signing.
- Backward compatibility shim: `agentId` field in API requests is accepted as an alias for `principalId` for one minor version.

### Memory provenance migration

- Existing memories have an `agentId` field. Add `principalId` as a synonym.
- Bootstrap, search, and trust scoring all consult `principalId` going forward.
- The `agentId` field stays in the schema indefinitely (no harm, easier rollback).

---

## 9. Open Questions (For K&S)

All seven of the original open questions have been resolved via K&S review on 2026-04-08. Resolutions below are now authoritative unless explicitly re-opened. Two additional questions surfaced during review and are captured in §9b.

1. ~~Recovery key escrow.~~ **RESOLVED — no escrow.** K&S agreed: recovery is via a fresh setup token issued through the deployment console (Fabric console for standalone hosted, rockit CLI for federated). Escrow creates a static credential that weakens the passkey-only model. Tying recovery to infrastructure access is the stronger boundary.

2. ~~WebAuthn attestation policy.~~ **RESOLVED — accept self-attestation.** Per Sherlock: strict attestation breaks iCloud Keychain, 1Password, Bitwarden, Dashlane — the actual ways humans use passkeys. The UX cost is not worth the marginal security gain. Documented trade-off: we accept that we cannot distinguish passkeys originating in software password managers from those in hardware authenticators. For threats that require hardware-backed keys (signing high-value transactions, privileged admin ops), an explicit attestation-required ceremony can be added later as an opt-in.

3. ~~DCR client validation.~~ **RESOLVED — hardcode Anthropic's redirect URI as the only permitted value for 1.0.** Per Sherlock: open DCR with arbitrary redirect URIs is an impersonation vector. The permitted redirect URI is `https://claude.com/api/mcp/auth_callback` (and its legacy `https://claude.ai/api/mcp/auth_callback` alias if Anthropic still publishes it). If support for additional MCP clients is needed later, introduce an admin allowlist — **not** open DCR.

4. ~~Trust tier defaults for humans.~~ **RESOLVED — admin gets `endorsed`, invitees get `unverified`.** Kern and Sherlock disagreed on the invitee default (Kern: `unverified`, Sherlock: `corroborated`). Resolved in Kern's favor because: (a) `corroborated` represents confirmed consensus from multiple sources, not a middle-ground default; an invited human has earned no consensus; (b) per Nathan's direction, time/passivity is not a trust signal — an invitee waiting to accrue trust without an explicit promotion signal is exactly the anti-pattern we're protecting against. Only admin promotion moves an invitee up.

5. ~~Single Principal vs separate principals per Claude device.~~ **RESOLVED — single Principal per human.** Confirmed by Nathan and Sherlock. One human maps to one Principal across all their Claude clients. The OAuth session, not the Principal, tracks the source client for audit purposes — client metadata (client_id, user_agent, last_ip) is stored with the session.

6. ~~Server-held Ed25519 key for humans.~~ **RESOLVED — threat accepted with mitigations.** Per Sherlock: humans can't manage cryptographic keys, and passkeys can't produce Ed25519 signatures directly. Flair holds the key. Mitigations: (a) HSM-backed key storage if Harper Fabric supports it (needs research); (b) encryption-at-rest with a key derived from a secret known only to the admin principal, otherwise; (c) off-site encrypted backups; (d) integrity monitoring — any unexpected change to a human Principal's publicKey is an alert condition.

7. ~~Bearer token entropy and format.~~ **RESOLVED — format approved.** `flair_at_<32 random bytes base62>` ≈ 42 chars, 256 bits of entropy. Stored server-side as a SHA-256 hash with an 8-char prefix retained for identification and scanning. The `flair_at_` prefix is required so secret-scanning tools (GitHub, TruffleHog, gitleaks) can detect accidentally committed tokens.

---

## 9b. New Open Questions Surfaced During K&S Review

1. **Signature-to-Principal binding at ingest (Kern).** Receiving Flair instances must verify that each record's Ed25519 signature matches the `publicKey` registered to the claimed `principalId` in the local Principal table — otherwise a compromised peer could "claim" a memory was written by any principal by simply re-signing it. This is primarily a federation-layer requirement and will be specified in `FLAIR-FEDERATION.md`, but it's referenced here because it justifies the decision to store each Principal's publicKey as a first-class field on the Principal record (not only on the Credential record). **Action:** ensure Principal schema has the publicKey at the top level, which it does. **Resolved by design, but must be enforced at the ingest layer in federation implementation.**

2. **Lamport clocks or per-record monotonic sequence for supersede chains (Kern).** For memory records specifically, LWW-by-timestamp can tie-break unpredictably when two instances write near-simultaneously. Kern recommended adding a Lamport clock or `(sequenceNumber, instanceId)` tuple to the supersede chain. This is a federation-layer concern but affects the record shape Flair will store going forward. **Action:** flagged for FLAIR-FEDERATION design. Principal-level records (which are metadata, not memory content) may need field-level LWW or set-CRDT semantics per Kern's note — also a federation concern.

3. **Migration atomicity across federated instances.** If rockit migrates to the Principal schema while hosted is still on the Agent schema, federation sync breaks. The federation handshake must include a `schema_version`. Mismatched versions → passive wait (no cross-version sync). **Action:** flagged for FLAIR-FEDERATION. This spec's migration plan assumes a single-instance migration; multi-instance coordination lives in federation.

---

## 10. Things Nathan Would Hate If We Built Them This Way

Explicit anti-goals to keep us honest:

1. **Email + password fallback** — there is no password, never has been, never will be. If passkeys can't recover, the deployment console can. Don't backdoor a worse credential type "for convenience."
2. **Multi-step wizards** — every flow that the user touches should be one screen, one decision, or one ceremony. Wizards are a tell that the data model is wrong for the task.
3. **OAuth jargon in user-facing copy** — "scopes," "client_id," "redirect_uri," "PKCE" — none of these belong in UI copy. Use plain English: "Claude wants to access your memories. Allow?"
4. **Asking the user to copy/paste secrets** — the only acceptable case is the bearer token shown once at creation, and only because the user explicitly created an agent credential that needs a token. Humans should never paste anything.
5. **Showing AAGUIDs, credential IDs, raw public keys** in user-facing UI. They go in admin/debug views only.
6. **Forcing a username distinct from display name** — the principal ID is generated, the display name is a label, that's it. No "username" concept.
7. **"Click here to verify your email"** — there is no email verification because there is no email. Recovery is via passkey or the deployment console, never email, never a recovery code.
8. **Five different "manage your account" pages** — one Settings page, organized by section. Don't fragment.
9. **Notifications about every credential use** — the activity log is browseable, but we don't push a "you signed in from MacBook" email after every login. That's noise.
10. **"For your security, you've been signed out"** without explanation — sessions live as long as their refresh tokens, full stop. If we end a session, we tell the user exactly why.

---

## 11. Out of Scope for This Spec

- **The actual sync protocol between two Flair instances.** Covered in FLAIR-FEDERATION.md. This spec assumes principals can be created on either instance and synced; the *how* lives in federation.
- **The web admin UI page set.** Covered in FLAIR-WEB-ADMIN.md. This spec specifies the data model and flows; the page implementation lives there.
- **Memory model, trust tiers, subjects.** Covered in MEMORY-MODEL-V2.md. This spec uses those concepts but doesn't redefine them.
- **Distillation of tribal knowledge.** Covered in DISTILL-TRIBAL-KNOWLEDGE.md. Distillation operates on memories, which now belong to principals; no semantic change.
- **Multi-tenant Flair (multiple unrelated organizations on one instance).** Not needed for 1.0. Each Flair instance serves one logical organization (one or more humans + their agents). Multi-tenant would require a Tenant concept above Principal.

---

## 12. Implementation Phasing

This spec is large. Suggested phasing for implementation, with each phase shippable independently:

**Phase 1 — Schema and Principal CRUD (no new auth)**
- Migrate Agent → Principal table
- Add Credential table
- Backfill existing agents
- CLI: principal create/list/show/update/deactivate
- API: /Principal endpoints with /Agent aliases
- No new auth methods yet — Ed25519 still the only path

**Phase 2 — Bearer tokens**
- Already specified in MEMORY-MODEL-V2 but reuses Credential table now
- CLI: credential create --kind bearer-token
- Auth middleware accepts `Authorization: Bearer flair_at_*`

**Phase 3 — WebAuthn**
- /auth/webauthn/register and /auth/webauthn/verify endpoints
- Browser-side ceremony helpers
- Cold-start claim flow + claim token generation
- First Principal created via web claim
- Inline credential add for already-authenticated principals

**Phase 4 — OAuth 2.1 server**
- Discovery, authorize, token, register, revoke endpoints
- Consent screen UI
- Server-held Ed25519 signing on behalf of OAuth-authenticated humans
- Test with Claude.ai custom connector flow end-to-end

**Phase 5 — Cross-device WebAuthn and recovery**
- QR-based cross-device flow (mostly browser-native, minimal Flair work)
- Deployment-console-initiated recovery token issuance (no escrow codes)
- Admin promotion / demotion
- Principal purge

Phases 1-2 are pure refactor + bearer tokens (no UX impact on Nathan beyond what MEMORY-MODEL-V2 already proposed). Phases 3-5 are the visible new product surface.

---

## 13. References

- MEMORY-MODEL-V2 (this repo, specs/) — trust tiers, subjects, bearer tokens
- FLAIR-FEDERATION (this repo, specs/) — instance identity, sync
- FLAIR-WEB-ADMIN (this repo, specs/) — admin UI page set
- MCP custom connector docs — https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers
- OAuth 2.1 draft — https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1
- WebAuthn Level 3 — https://www.w3.org/TR/webauthn-3/
- RFC 7591 (Dynamic Client Registration) — https://datatracker.ietf.org/doc/html/rfc7591
- ops-125 (CIMD design note) — Flair memory id flint-1774158599312
