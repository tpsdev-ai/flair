# Spec: Ed25519 per-agent auth in `@tpsdev-ai/n8n-nodes-flair`

**Goal:** Add Ed25519 per-agent authentication to the n8n Flair credential, alongside the existing v1 admin-password mode. Sherlock flagged this as required before any production deployment with sensitive memories or untrusted workflow inputs (PR #333 review carry-forward).

**Bead:** `ops-q3qf-followup-ed25519` (priority P2).

**Assumed milestone:** post-1.0 polish — operator-facing v1 (admin-password) is acceptable for the dogfood / launch beat; ed25519 is the production-hardening follow-up. Move into 1.0 scope if a launch use-case demands it.

---

## 1. Threat model — what this fixes

### v1 (admin-password) — current state
- n8n credential carries `admin:adminPassword` Basic auth.
- ANY workflow with that credential reads/writes the entire Flair instance.
- An n8n admin or backup-restore can extract the password.
- **Blast radius:** the whole memory store, all agents, all subjects.

### v1.1 (ed25519) — this spec
- n8n credential carries `agentId` + a private key (PEM).
- Each request is signed; Flair validates against the agent's stored public key.
- Workflows can only act as the configured agent — read/write is auth-scoped to that agent's memories (plus any MemoryGrants).
- **Blast radius:** one agent's memories. Compromising the credential does NOT grant other-agent access.

This is the same security boundary that flair-client + flair-mcp already provide for CLI/MCP surfaces today. The n8n credential is bringing parity.

---

## 2. Design

### 2.1 Credential — single type with Auth Mode dropdown

Extend the existing `flairApi` credential (introduced in PR #335) rather than minting a second type. Adds an `authMode` field as a top-level dropdown; other fields show/hide conditionally.

```ts
properties: INodeProperties[] = [
  { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'http://localhost:9926', required: true },
  { displayName: 'Agent ID', name: 'agentId', type: 'string', default: '', required: true },
  {
    displayName: 'Auth Mode',
    name: 'authMode',
    type: 'options',
    options: [
      { name: 'Admin Password (v1, full instance)', value: 'admin' },
      { name: 'Ed25519 (per-agent, recommended)', value: 'ed25519' },
    ],
    default: 'admin',
    required: true,
  },
  // Admin Password — shown when authMode = admin
  {
    displayName: 'Admin Password',
    name: 'adminPassword',
    type: 'string',
    typeOptions: { password: true },
    default: '',
    displayOptions: { show: { authMode: ['admin'] } },
    description: 'Sensitive: grants read/write to the entire instance.',
  },
  // Ed25519 — shown when authMode = ed25519
  {
    displayName: 'Private Key (PEM)',
    name: 'privateKey',
    type: 'string',
    typeOptions: { password: true, rows: 8 },
    default: '',
    displayOptions: { show: { authMode: ['ed25519'] } },
    description:
      'PEM-encoded Ed25519 private key for the agent. Generate via `flair agent add <id>` or `flair agent rotate <id>` and paste here. The corresponding public key must already be registered in Flair.',
  },
];
```

Why one credential, not two:
- Reduces credential proliferation in n8n's UI
- Operators can flip auth mode without re-wiring nodes
- Migration path: edit the credential, switch mode, paste key, save

### 2.2 Authenticate — custom function, not generic

n8n's `IAuthenticateGeneric` does header-template injection. Ed25519 needs per-request signing — the signature depends on the request method and path. This requires the `IAuthenticate` function form:

```ts
authenticate: async (
  credentials: ICredentialDataDecryptedObject,
  requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> => {
  const mode = credentials.authMode as string;
  if (mode === 'admin') {
    const password = credentials.adminPassword as string;
    requestOptions.headers = requestOptions.headers ?? {};
    requestOptions.headers.Authorization =
      `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
    return requestOptions;
  }
  if (mode === 'ed25519') {
    const agentId = credentials.agentId as string;
    const pem = credentials.privateKey as string;
    // Reuse @tpsdev-ai/flair-client's signRequest helper. Method + path
    // come from the requestOptions n8n built; we sign and attach Authorization.
    const key = createPrivateKey(pem);
    const url = new URL(requestOptions.url ?? '', requestOptions.baseURL ?? '');
    requestOptions.headers = requestOptions.headers ?? {};
    requestOptions.headers.Authorization = signRequest(
      agentId,
      key,
      requestOptions.method ?? 'GET',
      url.pathname + url.search,
    );
    return requestOptions;
  }
  throw new Error(`Unknown authMode: ${mode}`);
}
```

Two consequences:
- The credential type can no longer use `IAuthenticateGeneric`'s declarative form — switches to the function form
- `signRequest` from `@tpsdev-ai/flair-client` becomes a runtime dep (already a dep of the n8n package)

### 2.3 Credential test — auth-required endpoint

Same as the v1 fix: `/Memory` returns 401 without valid auth, so the test detects bad credentials in either mode.

```ts
test: ICredentialTestRequest = {
  request: { baseURL: '={{ $credentials.baseUrl }}', url: '/Memory' },
};
```

Note: when `authenticate` is a function (not generic), n8n still calls it for the test request. So the test exercises the actual signing path for ed25519 mode. Verified end-to-end.

### 2.4 Node-side change — pass key through, not user/password shim

`FlairChatMemory.node.ts` and `FlairSearch.node.ts` instantiate `FlairClient` with credentials. Today they pass `adminUser: "admin", adminPassword: credentials.adminPassword`. Update to branch on `authMode`:

```ts
const flair = credentials.authMode === 'ed25519'
  ? new FlairClient({
      url: credentials.baseUrl,
      agentId: credentials.agentId,
      privateKey: credentials.privateKey, // PEM string — flair-client loads via createPrivateKey
    })
  : new FlairClient({
      url: credentials.baseUrl,
      agentId: credentials.agentId,
      adminUser: 'admin',
      adminPassword: credentials.adminPassword,
    });
```

Wait — `FlairClient`'s constructor accepts `keyPath` (file path), not `privateKey` (in-memory PEM). For n8n we need to pass the PEM string in-memory because n8n's credential storage is the source of truth — there's no file to point at.

**Required upstream change in `@tpsdev-ai/flair-client`:** add a `privateKey?: string | KeyObject` config option that bypasses `keyPath` resolution and uses the supplied PEM/KeyObject directly. Small, backward-compatible. Ships as a separate PR before this n8n change can land.

### 2.5 Migration / coexistence

Existing operators on v1 (admin-password):
- Their credential has `adminPassword` set, `authMode` is undefined → treat as `'admin'` for backward compat
- The dropdown defaults to `'admin'` for new credentials too
- No forced migration; operators flip mode when ready

When `authMode` is undefined in stored credential data, the authenticate function should default to admin mode (preserves v1 behavior). The credential test still works because the auth function picks the right path.

### 2.6 Public-key registration

Flair already stores per-agent public keys at `flair agent add` time. The n8n credential just needs the matching private key — no registration step at credential-create time. Operator flow:

```bash
# On the host where Flair runs:
flair agent add my-n8n-bot

# Flair prints the private key path. Read it:
cat ~/.flair/keys/my-n8n-bot.priv.pem

# Paste that PEM block into the n8n credential's "Private Key (PEM)" field.
```

For rotation:

```bash
flair agent rotate my-n8n-bot
# Update the n8n credential with the new PEM. Old key still works until you remove it.
```

---

## 3. Implementation sequence

1. **PR-A — flair-client `privateKey` config option.** Small. Add `privateKey?: string | KeyObject` to `FlairClientConfig`. Resolution: if `privateKey` is set, use it directly; else fall back to `keyPath` resolution. Tests cover both paths.
2. **PR-B — n8n-nodes-flair credential update.** Switch `flairApi` to function-form `authenticate`. Add `authMode` dropdown + `privateKey` field. Both nodes (FlairChatMemory + FlairSearch) branch on `authMode` when constructing FlairClient.
3. **PR-C — docs.** Update `docs/n8n.md` Security section with the migration path and operator flow. Drop the "wait for Ed25519" caveat in v1 favor of a "to harden, switch Auth Mode to Ed25519" pointer.

Each PR: K&S ensemble, CI green.

---

## 4. Out of scope

- **Bring-your-own-CA / federation cross-instance auth** — separate concern. This spec is local credential auth; cross-instance trust uses Flair's own federation pairing.
- **Hardware key support** (YubiKey, etc.) — n8n credential storage doesn't have that surface today.
- **Programmatic key generation in n8n** — operator runs `flair agent add` on the Flair host. n8n is a consumer of the keypair, not a key custodian.

---

## 5. Why this isn't blocking 1.0

The 1.0 narrative is "memory across orchestrators." V1 (admin-password) achieves the narrative — the n8n surface works, memories are portable, federation carries them across instances. Ed25519 is *security hardening* on top of a working surface, not the surface itself.

Operators with sensitive workloads should be told (via docs, plain in `docs/n8n.md`) to wait for ed25519. Operators without that constraint can ship today.

If a 1.0 launch beat names a customer with strict isolation requirements, this moves from "follow-up" to "1.0 scope" and ships before launch.

---

## 6. Acceptance

1. `flairApi` credential exposes Auth Mode dropdown; admin-password remains default for backward compat.
2. Ed25519 mode uses function-form `authenticate` to sign each request; credential test against `/Memory` returns 200 only when both mode-specific fields are correct.
3. Both `FlairChatMemory` and `FlairSearch` work in either mode without other config changes.
4. `flair-client` accepts an in-memory `privateKey` PEM/KeyObject without requiring a key file on disk.
5. `docs/n8n.md` Security section documents the operator migration flow.
