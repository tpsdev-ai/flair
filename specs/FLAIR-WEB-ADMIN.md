# Flair Web Admin

## Status
- **Owner:** Flint
- **Priority:** P1 — required for 1.0 (standalone hosted users have no CLI access)
- **Context:** Design sessions with Nathan 2026-04-07 / 2026-04-08
- **Reviewers:** Kern (architecture), Sherlock (security) — pending review
- **Composes with:** FLAIR-PRINCIPALS, FLAIR-FEDERATION, FLAIR-CLI, MEMORY-MODEL-V2

## Summary

Flair 1.0 has two first-class topologies: local (CLI-driven, `flair init`) and hosted on Fabric (no CLI access). The hosted topology forces a web admin surface to exist — without one, a standalone hosted user can't manage their principals, credentials, or memory. This spec defines that surface.

The web admin is **Nathan-grade**, not consumer-grade. The audience is Nathan (or someone similar — technical, opinionated, evaluating with a consumer lens but not demanding marketing-quality polish). Every flow has to feel complete; no insider shortcuts. But the visual polish budget is proportional to Nathan's tolerance, not to a public product launch.

For federated users with a CLI, the web admin is **supplementary** — most things can be done faster via `flair` commands, but the web admin is always available for browser-friendly tasks (reviewing connector approvals, browsing memory, exporting backups).

**Key principles:**

1. **Page set is fixed and small.** ~12 pages total. No plugin architecture, no custom dashboards, no "build your own view."
2. **No client-side framework dependency beyond what's needed for WebAuthn.** Progressive enhancement. Server-rendered HTML first, JS only where it adds value (WebAuthn ceremony, memory search filtering).
3. **Every page has defined empty states, error states, and loading states.** "It hasn't loaded yet" is a real state the user will see; we design for it.
4. **Copy is in plain English.** No OAuth jargon, no WebAuthn jargon, no "PKCE" or "AAGUID" in the user-visible surface.
5. **The admin surface is the SAME URL base as the API.** A single Flair instance serves both `/oauth/*` and `/admin/*` from the same origin. This is load-bearing for OAuth: the authorize endpoint has to render HTML, and the consent screen belongs with the rest of the web admin.

---

## 1. Overall Shape

### URL layout

```
/                                   → redirects to /admin (if logged in) or /login
/setup/<one-time-token>              → first-time claim / register passkey
/login                               → WebAuthn sign-in
/logout                              → clears session, redirects to /login

/admin                               → dashboard home
/admin/principals                    → principals list
/admin/principals/<id>               → principal detail + edit
/admin/principals/new                → create a new principal (admin only)
/admin/credentials                   → your own credentials (devices / passkeys)
/admin/connectors                    → OAuth clients + sessions that have access to Flair
/admin/subjects                      → subjects manager
/admin/memory                        → memory browse + search
/admin/memory/<id>                   → single memory view
/admin/federation                    → peer and sync status (federated mode only)
/admin/instance                      → instance info (id, public key, passphrase backup reminder, version)
/admin/settings                      → per-user preferences

/oauth/authorize                     → OAuth consent screen (rendered HTML)
/oauth/token                         → OAuth token endpoint (JSON)
/oauth/register                      → OAuth DCR endpoint (JSON)
/.well-known/oauth-authorization-server → OAuth discovery (JSON)

/api/*                               → programmatic API (not user-facing)
/mcp                                 → flair-mcp HTTP endpoint
/sync                                → WSS federation endpoint
/pair                                → HTTP one-shot pair handshake
/instance-identity.json              → public key publication
```

### Navigation

The left sidebar (collapsed on mobile) shows:

- **Home** (`/admin`)
- **Memory** (`/admin/memory`)
- **Principals** (`/admin/principals`)
- **Connectors** (`/admin/connectors`)
- **Federation** (`/admin/federation`, only shown in federated mode)
- **Subjects** (`/admin/subjects`)
- **Instance** (`/admin/instance`)
- **Settings** (`/admin/settings`)

Footer: Flair version, commit hash, link to docs.

Header: current user's display name, sign-out button, instance id (small, for diagnostic copy-paste).

---

## 2. The Required OAuth / Setup Pages

These pages have to exist because OAuth and WebAuthn require them. They're the load-bearing web surface that justifies having a web admin at all.

### 2.1 `/setup/<token>` — claim or register a device

**Purpose:** consume a one-time setup token to either (a) claim the instance as the first principal (cold start) or (b) register a new WebAuthn credential for an existing principal.

**Query:** `/setup/<token>` — token is consumed on first use

**Rendered as a single screen, not a wizard.** One action, one button, one ceremony.

**Cold start flow (no principal exists yet):**
- Headline: "Welcome to Flair"
- Subhead: "Set up the account you'll use across all your devices"
- One field: Display name (prefilled from `$USER` on local deploys, empty on remote)
- One button: "Create account with passkey"
- Footer: small "What's a passkey?" link → modal in plain English ("A passkey uses your device's built-in biometrics to sign in — Touch ID on Mac, Face ID on iPhone. No passwords. See [more]")

On click: WebAuthn registration ceremony → on success, redirect to `/admin`.

**Credential add flow (existing principal adding a device):**
- Headline: "Add a new device for <display name>"
- Subhead: "Register this device so you can sign in from it"
- Summary: "This will create a passkey on the device you're currently using"
- One button: "Register this device"
- Footer: link back to `/admin/credentials` to cancel

On click: WebAuthn registration → redirect to `/admin/credentials` with a success toast.

**Empty states / errors:**
- Expired token: "This setup link has expired. Generate a new one from the Flair CLI on rockit, or ask the admin."
- Already consumed: "This setup link has already been used. If you need to register another device, create a new setup link."
- No WebAuthn support in browser: "Your browser doesn't support passkeys. Try Safari, Chrome, Firefox, or Edge on a device with biometric authentication."

### 2.2 `/login` — WebAuthn sign-in

**Purpose:** log in with an existing passkey.

- Headline: "Sign in to Flair"
- One button: "Use your passkey"
- Footer: "Don't have a passkey on this device? [Add a new device]" → explains the cross-device flow (explained below)

On button click: WebAuthn `navigator.credentials.get()` → browser prompts (Touch ID, Face ID, security key, synced passkey) → assertion signed → POST to `/api/auth/webauthn/verify` → server returns session cookie → redirect to `/admin`.

**Cross-device WebAuthn:** if the user clicks "Use your passkey" on a device with no local passkey, the browser offers "Use a phone, tablet, or security key." This triggers the cross-device WebAuthn flow (browser-native, no custom Flair logic) with a QR code. User scans on iPhone, FaceID, done — the assertion is relayed back to the original device.

**After cross-device sign-in**, Flair detects "this device doesn't have a local credential yet" and offers: "Save a passkey to this device for next time?" → one-click WebAuthn registration for a new local credential bound to the same principal.

**Empty states:**
- No principals exist (cold start): redirect to `/setup/<generated-claim-token>` automatically if the instance has an un-consumed claim token waiting.
- No passkey on this device and cross-device fails: "Couldn't complete sign-in. Try a device that has a passkey, or generate a new setup link from the CLI."

### 2.3 `/oauth/authorize` — OAuth consent screen

**Purpose:** Claude (or any future MCP client) redirects the user here to approve a connector. This screen is the only thing Claude's users see when they add Flair as a custom connector.

**Flow:**
1. Claude.ai hits `/oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...&code_challenge=...`
2. Flair checks: is the user already logged in via a session cookie? If not, redirect to `/login?next=<current-url>`.
3. Once logged in, render the consent screen.

**Consent screen:**
- Headline: "Claude wants to access your Flair memories"
- App identity (from DCR metadata): Claude's icon + name + description
- Scopes in plain English, not OAuth strings:
  - "Read your memories"
  - "Write new memories on your behalf"
  - "Manage memory metadata (tags, subjects)"
- Two buttons: **"Approve"** (primary, green) and **"Cancel"** (secondary)
- Fine print: "You can revoke this access at any time from the Connectors page."

On Approve: server generates an authorization code, redirects to the client's `redirect_uri` with `code=...&state=...`. Claude's backend exchanges the code at `/oauth/token` for tokens, stores them.

On Cancel: redirect to `redirect_uri` with `error=access_denied&state=...`.

**Anti-goals:**
- Showing raw OAuth jargon (`client_id`, `redirect_uri`, `PKCE`)
- Listing scopes as `memories:read memories:write` (use English)
- A "remember this decision" checkbox (there's no session-based "always allow" — each authorize action is explicit)

### 2.4 Session timeout / re-auth

If a user's session cookie expires during any admin action, redirect to `/login?next=<current-url>` with a toast: "Your session expired. Sign in to continue where you left off."

No auto-refresh. No silent retry. Explicit re-authentication.

---

## 3. The Admin Dashboard

### 3.1 `/admin` — home

**Purpose:** one-screen status overview. What's working, what needs attention.

**Layout:** cards, not tables. Each card is one topic.

Cards:

- **Instance status**
  - Mode: local / hosted / federated
  - Role: standalone / hub / spoke
  - Version: flair 1.0.3 (Harper 5.0.0)
  - Uptime: 3 days
  - Public endpoint: `https://mycluster.harper.fabric`
  - Small status light: green (healthy), amber (degraded), red (error)

- **Federation** (if federated mode)
  - Connected peers: 2 / 2
  - Last sync: 12 seconds ago
  - Replication lag: <1 second
  - Link: "See peer details →" → `/admin/federation`

- **Principals summary**
  - "1 human, 5 agents, 1 deactivated"
  - Link: "Manage principals →" → `/admin/principals`

- **Recent activity**
  - "23 memories added in the last 7 days"
  - "2 connectors active"
  - Link: "Browse memory →" → `/admin/memory`

- **Action required** (only shown if there's something to do)
  - "You haven't backed up your instance passphrase. [Back up now]"
  - "Claude iOS connector expires in 3 days. [Renew]"
  - "Spoke 'anvil-vm' hasn't synced in 2 hours. [Investigate]"
  - Each item is dismissible (remembers dismissal in user settings)

**Empty state:** if this is a fresh instance with no data yet, the dashboard shows a "Getting started" card instead:

- "You're ready. Here's what to do next:"
  - "Back up your instance passphrase" → `/admin/instance#backup`
  - "Connect Claude (optional)" → guide to adding Flair as a custom connector
  - "Write your first memory" → `/admin/memory?new=1`

---

## 4. Principals

### 4.1 `/admin/principals` — list

Table with columns:
- **Name** (display name)
- **Kind** (human / agent)
- **Status** (active / deactivated)
- **Trust tier** (endorsed / corroborated / unverified)
- **Credentials** (count)
- **Memories** (count)
- **Last active**

Top bar: filter by kind, search by name, "New principal" button (admin only).

Row click → `/admin/principals/<id>`.

### 4.2 `/admin/principals/<id>` — detail

Sections:

- **Header:** display name, kind badge, status badge, principal id (small, copyable)
- **Subjects:** chips you can add/remove inline
- **Trust tier:** current tier, admin-only dropdown to promote/demote (with a confirmation modal explaining the impact)
- **Credentials:** list of devices/keys with per-credential "revoke" button
- **Recent memories:** last 20 memories, with link to full memory browse filtered to this principal
- **Danger zone:** deactivate button (reversible), purge button (admin only, with very prominent warning)

**Trust tier change modal:**
- "Promote [name] to Endorsed?"
- "Endorsed means their memories will surface in cross-agent bootstrap at the highest priority. Only promote principals you trust to write authoritative knowledge."
- [Cancel] [Promote]

### 4.3 `/admin/principals/new` — create

Admin-only. Form fields:
- **Kind:** human / agent radio
- **Display name:** text input
- **Initial trust tier:** dropdown (defaults to `unverified`)
- **Subjects:** comma-separated text input (can be empty)
- For agents: **Runtime:** dropdown (openclaw, claude-code, headless, external, none)

Submit → creates the Principal record. For humans, also generates a one-time setup token and redirects to `/admin/principals/<id>?setup=<token>`, which shows a single-use URL the admin can send to the invited human: "`https://flair.example.com/setup/<token>` — Share this link with them. Expires in 10 minutes."

---

## 5. Credentials

### 5.1 `/admin/credentials` — your own credentials

For the currently logged-in principal (which must be human, since agents don't log in via web).

Sections:

- **Passkeys** — list of WebAuthn credentials, each with:
  - Device label (e.g. "iPhone 16 Pro", "MacBook Pro")
  - Created date
  - Last used
  - AAGUID-based icon if recognizable (iCloud Keychain, 1Password, Yubikey, etc.)
  - "Rename" button → simple modal
  - "Revoke" button → confirmation modal ("Revoke MacBook Pro? You won't be able to sign in from this device until you register a new passkey on it.")

- **Add a device** — button that either:
  - Triggers WebAuthn registration ceremony on the current device (if the user says "this device")
  - Generates a one-time URL + QR code they can open on the target device (if they say "a different device")

- **Bearer tokens** (only shown if admin and at least one exists)
  - List of bearer tokens with label, prefix, created, last used, revoke
  - Separate "Create bearer token" button → generates a new token, shows it once, never again

### 5.2 Admin view of other principals' credentials

From `/admin/principals/<id>` → Credentials section. Admin can see each agent's credentials, revoke them, and create new bearer tokens for agents. Cannot see other humans' credentials beyond metadata (no credential details for another human).

---

## 6. Connectors (OAuth clients and sessions)

### `/admin/connectors` — who has access

Two tabs:

**Tab 1: Registered clients.** OAuth clients that have been DCR-registered (for 1.0, this is effectively just Claude). Each client shows:
- Name (from DCR metadata)
- Client ID
- Redirect URI
- Registered at
- Revoke button

**Tab 2: Active sessions.** OAuth sessions that are currently holding access + refresh tokens:
- Client name (Claude)
- Principal (the human this session acts on behalf of)
- Last client user-agent / platform ("Claude iOS", "Claude Code on MacBook")
- Created
- Last used
- Expires
- Revoke button

Revoking a client invalidates all its sessions. Revoking a session invalidates just that one.

**Empty state:** "No connectors yet. [Connect Claude]" → instructions on how to add Flair as a custom connector in claude.ai.

---

## 7. Subjects

### `/admin/subjects`

Simple two-column view:

- **Known subjects** (computed from all principals' declared subjects and all memories' subject tags)
- **Your subjects** (what the current user's principal has declared)

Click a subject → see which principals have it and how many memories carry it.

Actions:
- Add a new subject to your principal
- Remove a subject from your principal
- (Admin) add/remove subjects on any principal

No formal schema for subjects; they're freeform strings. Normalization happens at display time (lowercased, trimmed, de-duped).

---

## 8. Memory Browse

### 8.1 `/admin/memory` — browse and search

Two panes:

**Left: filter controls**
- Search box (full-text + semantic-aware)
- Filter by subject (multi-select)
- Filter by principal (multi-select)
- Filter by trust tier (multi-select)
- Filter by durability (multi-select)
- Filter by date range

**Right: result list**
- Each result: content preview, principal, trust tier badge, subject chips, age, search score
- Click → `/admin/memory/<id>`

**Empty state:** "No memories match those filters. [Clear filters]"

**Loading state:** skeleton rows (not a spinner — the layout shouldn't shift as results load)

**Action buttons at top of results:**
- Export visible results as JSON (for backup or analysis)
- Select all → bulk actions (revoke trust tier, add subject, delete — admin only)

### 8.2 `/admin/memory/<id>` — single memory view

Full content, metadata sidebar (id, principal, created, updated, lamport clock value, originating instance, subjects, tags, durability, trust tier, supersede chain up/down), action buttons (correct / supersede, delete, change subject).

**Supersede view:** if this memory supersedes or has been superseded, show the chain as a vertical list, current one highlighted.

---

## 9. Federation (Federated Mode Only)

### `/admin/federation`

Only visible if `flair.role` is `hub` or `spoke`.

**For a hub:**
- List of connected spokes with per-spoke status (connected / catching up / disconnected)
- Per-spoke sync metrics (replication lag, frames/sec)
- "Generate setup link for a new spoke" button (produces a one-time bootstrap token, wraps it in a URL, copies to clipboard with a "share this with the spoke operator" hint)
- Revoke peer button per spoke

**For a spoke:**
- Current hub (endpoint, instance id, pinned public key fingerprint)
- Connection status + last sync time
- Replication lag
- "Unpair" button (with confirmation)

**Empty state (hub with no spokes):** "No spokes connected. Run `flair pair add --hub wss://...` from a spoke machine to connect one."

---

## 10. Instance Info

### `/admin/instance`

Read-mostly diagnostic page:

- **Identity:** instance id (copy button), public key fingerprint (copy button), created at
- **Version:** Flair version, Harper version, bundled component versions
- **Role:** standalone / hub / spoke, configured peers
- **Uptime:** since last restart
- **Data stats:** principal count, memory count, credential count, Harper database size

**Passphrase backup reminder block:**

If the current admin has never viewed the passphrase (tracked in per-user settings), show a prominent callout:

- "⚠ You haven't backed up your instance passphrase."
- "Your instance private key is protected by a passphrase stored in your local OS keychain. If you lose the keychain without backing up the passphrase, you'll need to re-pair this instance with its peers."
- Button: "Reveal passphrase for backup"

Click → confirmation modal:
- "This will show your instance passphrase in plaintext."
- "Anyone with this value can decrypt your instance private key. Only reveal it in a secure environment."
- "Copy it to your password manager or a secure note immediately. This dialog shows the passphrase once — no re-display."
- [Cancel] [Continue]

Continue → shows passphrase in a bordered copy-friendly block with a manual "I copied it" button to dismiss. No auto-copy to clipboard (clipboards leak).

After dismissal, the dashboard remembers that the passphrase has been viewed at least once (per-user setting) and stops showing the callout.

---

## 11. Settings

### `/admin/settings`

Per-user preferences for the logged-in principal. Not many:

- Display name (editable)
- Default memory search subject (preset subject applied to new searches)
- UI theme (light / dark / auto)
- Notification preferences (toast durations, sound on/off)

Not in 1.0:
- Internationalization
- Custom keyboard shortcuts
- Profile photo / avatar upload

---

## 12. UX Flows (Nathan-Grade)

### Flow 1: First-time claim on standalone hosted

1. Nathan runs `flair deploy --target fabric://mycluster.harper.fabric`
2. CLI completes deploy and prints: "Your Flair hub is live. Open https://mycluster.harper.fabric/setup/<token> to claim it."
3. Nathan clicks the link on his Mac
4. Setup page renders, display name prefilled with "Nathan", "Create account with passkey" button
5. Click → Touch ID prompt → passkey created
6. Redirected to `/admin`
7. Dashboard shows: Instance status card (healthy, 0 days old, 1 principal), Getting Started card with "Back up your instance passphrase" as the first item
8. Nathan clicks the backup item → Instance page → Reveal → Confirmation → Passphrase shown → Nathan copies to 1Password → "I copied it" → callout dismissed

Elapsed time: ~90 seconds from `flair deploy` completing to a working admin session.

**Anti-goals:**
- Any intermediate page that says "please wait while we set up your account"
- A welcome wizard with progress dots
- Required email
- Required phone number

### Flow 2: Adding Claude as a custom connector

1. Nathan (already logged in to Flair on his Mac) goes to `claude.ai`
2. Settings → Connectors → Add Custom Connector → URL: `https://mycluster.harper.fabric`
3. Claude.ai backend does discovery, DCR, redirects Nathan's browser to `https://mycluster.harper.fabric/oauth/authorize?...`
4. Flair checks session cookie — Nathan is already logged in — renders consent screen directly (no re-login)
5. Consent screen: "Claude wants to access your Flair memories. Read memories, write new memories, manage metadata." [Approve] [Cancel]
6. Approve → redirect to `claude.com/api/mcp/auth_callback?code=...`
7. Claude.ai exchanges code for tokens, stores them
8. Connector appears in Claude.ai's list, syncs to Nathan's iPhone
9. Nathan opens Claude iOS, asks "what's in my memory about the Flair launch?" — it works

**Anti-goals:**
- Forcing a login even though a session cookie exists
- Showing raw OAuth scope strings on the consent screen
- A "review permissions" page before consent (one screen, one decision)

### Flow 3: Revoking a stolen MacBook

1. Nathan's MacBook is stolen. He's on his iPhone, logged in via the iOS web browser.
2. Goes to `/admin/credentials`
3. Sees two passkeys: "iPhone 16 Pro" (current device, highlighted), "MacBook Pro"
4. Taps "Revoke" next to MacBook Pro
5. Confirmation modal: "Revoke MacBook Pro? You won't be able to sign in from this device until you register a new passkey on it. This also invalidates any Claude sessions that originated from that Mac."
6. Tap Confirm → success toast "MacBook Pro revoked"
7. Flair also invalidates any OAuth sessions with client fingerprints matching the MacBook (if they're identifiable) — Nathan sees a second toast "3 Claude sessions tied to MacBook Pro were also revoked"

**Anti-goals:**
- Requiring the passkey to confirm ("this device's Touch ID doesn't help verify intent because the attacker has the MacBook, not me")
- Vague confirmation text
- Burying device management deep in Settings

### Flow 4: Browsing memory to find something specific

1. Nathan opens `/admin/memory`
2. Types in the search box: "when did we decide to move Flair off the Harper Core clustering path"
3. Results render as he types (debounced 200ms)
4. Top result is the exact decision memory, score 0.94
5. Click → full memory view, sidebar shows subject "flair-architecture", corroborated trust tier, supersede chain showing this memory supersedes an earlier "still evaluating Harper Pro" note
6. Nathan clicks the superseded memory to see what we used to think → chain navigation works bidirectionally

**Anti-goals:**
- Requiring a search button click (search as you type is expected UX now)
- Jumping the layout when new results load
- No way to see the supersede chain history

### Flow 5: Inviting a teammate (human principal)

Lower priority for 1.0 because 1.0 audience is Nathan only, but the flow should work:

1. Nathan is admin, goes to `/admin/principals/new`
2. Kind: Human, Display name: "Sam", Trust tier: Unverified, Subjects: (empty)
3. Create → Flair creates Principal + generates setup token
4. Redirects to `/admin/principals/<sam-id>?setup=<token>`
5. Page shows: "Share this link with Sam: https://flair.example.com/setup/<token> — expires in 10 minutes"
6. Copy button next to the URL
7. Nathan sends the URL to Sam however (Slack, Signal, email, in person)
8. Sam opens the link on her device, registers passkey, is now a usable principal

**Anti-goals:**
- Email invite built into Flair (Flair doesn't know about email and we don't want it to)
- Auto-copy of the invite URL (force the admin to explicitly copy so they think about where they're sending it)

---

## 13. Implementation Notes

### Tech choices

- **Server-rendered HTML as the baseline.** Each page is a server-rendered template with HTML forms for interactions.
- **JS for WebAuthn and for search-as-you-type only.** No SPA framework, no client routing, no state management library. Vanilla JS + HTML forms + a small stdlib of helpers.
- **Styling:** Tailwind-like utility classes or a small hand-rolled CSS. Not a heavy design system.
- **Session cookies:** HttpOnly, Secure, SameSite=Lax, with CSRF tokens on all state-changing endpoints.
- **Templates:** whatever Harper's resource layer supports natively (or a small template rendering layer on top). Not a React app.

### What the web admin shares with the rest of Flair

The admin is a set of Harper resources like any other Flair endpoint. It:

- Uses the same `/api/*` endpoints the CLI uses (no parallel admin-only APIs)
- Authenticates via WebAuthn-backed session cookies (not OAuth tokens — OAuth is for external clients like Claude)
- Renders templates that call into the same Principal / Memory / Credential resources
- Shares the same rate limiting, content safety, and trust-tier gating as the CLI

The admin is not a separate "admin app." It's a set of HTML routes on the same Flair process.

### Accessibility

For 1.0:
- All interactive elements are keyboard-navigable
- All images have alt text
- Color contrast meets WCAG AA
- Screen reader labels on icon-only buttons
- No animations that require motion preference consideration

Not in 1.0:
- Full WCAG AAA audit
- RTL language support
- Localization beyond English

### Mobile

Responsive layout (sidebar collapses to a drawer on small screens). All flows work on mobile browsers. Passkey UX is particularly important on mobile since that's where Touch ID / Face ID are most natural.

Not in 1.0: a dedicated iOS or Android app. The web surface is the mobile surface.

---

## 14. Things Nathan Would Hate If We Built Them This Way

1. **A React SPA that loads 3 MB of JS before showing the login screen.** Plain HTML, server-rendered. JS only where it earns its weight.
2. **OAuth jargon on user-facing pages.** The word "PKCE" should never appear in the admin UI.
3. **Wizards with progress dots.** Every flow is one screen, one decision.
4. **Unlabeled icon buttons.** Every action has a visible or accessible label.
5. **"Are you sure?" modals that require re-entering a password** — there is no password to re-enter, and WebAuthn re-auth for destructive operations creates friction without meaningful security.
6. **Auto-copy of secrets to clipboard.** Clipboards leak across apps and sometimes across devices. User copies manually so they think about where it's going.
7. **Silent auto-save on form fields.** Explicit save button for state-changing actions. Exception: search-as-you-type, which is not state-changing.
8. **Infinite scroll on memory lists.** Pagination. Show me how many results I have. Let me jump to the end if I want.
9. **A "dashboard" that's a wall of charts and graphs.** Cards with one fact each. Charts only if the chart tells me something I can't see another way.
10. **Dismissing the setup/backup nag once and never showing it again regardless of state.** If the passphrase changes (rotation) or the user's backup status changes, the callout returns. Permanent dismissal only after actual backup.
11. **Error messages that say "An error occurred."** Say what happened, say what the user can do, link to the relevant fix if there is one.
12. **"Session expired" redirects that lose the user's context.** Always redirect back to where they were with `next=<url>`.

---

## 15. Out of Scope for 1.0

- **Multi-tenant / multi-org support.** 1.0 assumes one Flair instance serves one organization.
- **Role-based access control beyond admin / non-admin.** 1.0 has two roles. Fine-grained RBAC is a future concern.
- **Audit log UI.** Audit events are stored in Harper data and accessible via API, but no web page renders them in 1.0.
- **Real-time event streaming in the UI.** The dashboard polls; it doesn't subscribe to a change feed.
- **Onboarding tutorials or tooltips.** The first-run experience is concrete steps in the Getting Started card, not an interactive tutorial overlay.
- **Theming / white-labeling.** One default theme (light), with an auto dark mode.
- **Plugin architecture for custom admin pages.** The page set is fixed in 1.0.
- **Export to formats other than JSON.** CSV, Markdown, etc. are future features.
- **Search within memory content that respects MarkDown structure.** Plain text full-text search is enough for 1.0.

---

## 16. Implementation Phasing

**Phase 1 — Load-bearing OAuth/WebAuthn pages**
- `/setup/<token>` claim + device registration
- `/login` WebAuthn sign-in
- `/oauth/authorize` consent screen
- Session cookie mechanism, CSRF tokens, logout
- Minimal shell: header, sidebar, dashboard stub

**Phase 2 — Principal and credential management**
- `/admin/principals` list + detail + edit + create
- `/admin/credentials` (own + other via principal detail)
- Revoke and deactivate flows with confirmations
- Admin role flag enforcement

**Phase 3 — Memory and subjects**
- `/admin/memory` browse + search + filters
- `/admin/memory/<id>` detail + supersede chain view
- `/admin/subjects` list + add/remove

**Phase 4 — Connectors, federation, instance**
- `/admin/connectors` OAuth clients + sessions + revocation
- `/admin/federation` peer list + metrics + add spoke + unpair
- `/admin/instance` diagnostics + passphrase backup flow

**Phase 5 — Settings and polish**
- `/admin/settings` per-user preferences
- Empty states, error states, loading states across the board
- Mobile responsiveness
- Accessibility pass

Phases 1 and 3 are the minimum viable admin for a standalone hosted user to function. Phases 2 and 4 fill in the rest. Phase 5 closes the "Nathan-grade" UX loop.

---

## 17. References

- FLAIR-PRINCIPALS — principal/credential data model
- FLAIR-FEDERATION — peer management, sync status
- FLAIR-CLI — parallel CLI for the same operations (admin is a supplementary surface)
- MEMORY-MODEL-V2 — trust tiers, subjects, memory semantics
- WebAuthn Level 3 — https://www.w3.org/TR/webauthn-3/
- OAuth 2.1 draft — https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1
