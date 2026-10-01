# Who can connect to your Flair

Three separate checks decide who can use the native `/mcp` endpoint of a hosted
Flair. **Which people:** a person signs in at your identity provider, and Flair
acts as the principal that login is mapped to. A login with no mapping cannot
call tools, unless you turn on just-in-time provisioning (off by default), which
creates a principal for it. **Which apps:** new apps identify themselves with a
Client ID Metadata Document, and the shipped `allowedHosts` list (`claude.ai`
and `claude.com`) limits which hosts may serve one. Registration of new clients
is off; clients registered while it was on keep using their stored client IDs
until their records are removed. **What they can touch:** a connection acts as
its principal. For a non-admin principal, that means writing its own memories
and reading them plus other agents' non-private ones. `flair principal disable`
marks a principal deactivated, which refuses its tool calls and keeps its data.

This page covers `/mcp`, where apps such as Claude sign people in with OAuth.
Agents that sign each request with their own Ed25519 key use a different path,
described in [auth.md](auth.md#ed25519-agent-auth-default) and in
[worked example 4](#4-a-bot-on-another-host-signs-with-its-own-key). How `/mcp`
is turned on is in [mcp-clients.md — Two MCP paths](mcp-clients.md#two-mcp-paths).

## 1. Which people

When someone connects an app, the app sends them to Flair's authorization
server, which has them sign in at the identity provider configured under
`'@harperfast/oauth'` → `providers` in Flair's `config.yaml`. The shipped file
configures GitHub. The access token the app receives carries the login as its
subject; for GitHub, that is the account's username.

`/mcp` answers `initialize`, `ping` and `tools/list` for any valid token, and
refuses a `tools/call` for an unknown tool name, before it looks at the mapping.
On a `tools/call` for a known tool, Flair looks for a `Credential` of kind `idp`
whose `idpSubject` is that login, that names a principal, and whose status is
not `revoked`, and acts as that principal. There is no fallback to an anonymous
or admin identity:

- **No mapping:** the call is refused. `/mcp` answers HTTP 200 with a JSON-RPC
  error:

  ```json
  {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"forbidden: token subject is not a provisioned flair agent"}}
  ```

- **Mapped to a principal that does not exist:** refused with code `-32001` and
  a message naming the principal.
- **Mapped to a deactivated principal:** refused; see
  [Revoking access](#revoking-access).
- **The credential or the principal could not be read:** refused with code
  `-32000` and a message starting `unavailable:`.

### Map a person to a principal

`flair mcp enable` writes the mapping in its `identity-mapping` step:

```bash
flair mcp enable \
  --instance https://flair.example.com \
  --idp-subject alice \
  --principal alice \
  --admin-pass "$TARGET_ADMIN_PASS"
```

- `--idp-subject` is the login the identity provider reports: for GitHub, the
  username.
- `--principal` is the principal that every `/mcp` call from that login reads
  and writes as. It defaults to `self`. If no principal with that id exists, the
  step creates a non-admin one, of kind `human` unless you pass
  `--principal-kind agent`.
- `--admin-pass` is the target instance's admin password. Outside `--dry-run`,
  this command does not fall back to `FLAIR_ADMIN_PASS` or
  `~/.flair/admin-pass`. It writes the mapping through the target's operations
  API on port 9925 of the `--instance` host. <!-- docs-freshness-allow: hosted operations API port, not the data port -->
- In a terminal, and outside `--dry-run`, it prompts for the GitHub OAuth app's
  client id and secret when `--idp-client-id` and `--idp-client-secret` are not
  passed.

The step's output states the mapping it wrote. The line starts:

```
connector identity: sub 'alice' (provider 'github') resolves to Agent 'alice' — every /mcp call reads and writes AS 'alice'. principal created; Credential(kind:idp) created (cred_idp_github_<12 hex digits>).
```

`flair mcp enable` runs the whole enablement flow, not only this step. To add a
person to an instance that is already enabled, also pass
`--secrets-mechanism env-file`, so that the secrets it stages go to a local
`0600` file and are not sent to the instance. Then answer `n` when it asks
whether the staged secrets are applied. The `identity-mapping` step has run by
then; a ✓ on it in the printed steps means the write was accepted and the
read-back described under [One mapping per login](#one-mapping-per-login)
passed. The command stops before restarting the instance, reports the
`secrets-provisioning` step as not applied, and exits non-zero.

### One mapping per login

`flair mcp enable` and the resolver both count a login's `idp` credential unless
its status is `revoked` (the resolver also skips one that names no principal).
`flair mcp enable` keeps one such credential per login, whatever the provider
name:

- Running it again with the same `--idp-subject` and `--idp-provider` and a
  different `--principal` re-points the existing credential, and the output
  says `re-pointed`. Calls from that login then act as the principal the
  credential names. Memories are not moved or merged; each principal keeps its
  own.
- If the login has a credential that is not `revoked` under a different
  provider name, the run revokes it (the row stays, with status `revoked`) and
  prints its id after `SUPERSEDED:`.
- After writing, it reads the login's credentials back and fails unless exactly
  one of them is not `revoked` and that one is the credential it wrote. It does
  not compare the principal that credential names: `bootstrap`'s `agentId` (see
  [Check who you are](#check-who-you-are)) shows which principal the login
  resolves to.

### Just-in-time provisioning

`FLAIR_MCP_JIT_PROVISION` is off by default; `1`, `true`, `yes` or `on` turns
it on. It changes the "no mapping" case: instead of refusing, Flair creates a
principal for the login on its first call to a known tool and maps the login to
it (if that write fails, the call is refused as in the "no mapping" case). The
new principal is a non-admin agent with trust tier `unverified`, and its id has
the form `agt_mcp_<login>_<8 hex digits>`, where characters other than letters
and digits become `_` and the login part is cut to 24 characters. Its
credential records the provider as `mcp-oauth`.

Flair adds no check of its own in this mode: a login the authorization server
issued a token for gets a principal on its first call to a known tool. Flair's
shipped configuration does not restrict which GitHub accounts can sign in. Turn
it on only when that is what you want, and set it in the instance's process
environment, like `FLAIR_MCP_OAUTH`.

## 2. Which apps

New apps identify themselves with a Client ID Metadata Document (CIMD): the
`client_id` is an HTTPS URL, and Flair's authorization server fetches the
document from that URL, and caches it, when a person starts to sign in. Clients
registered before registration was turned off use their stored client IDs
instead (see below).

- **Registration of new clients is off.** The shipped `config.yaml` sets
  `dynamicClientRegistration.enabled: false`, so `POST /oauth/mcp/register`
  answers `404 {"error":"Not found"}`, and the metadata at
  `/.well-known/oauth-authorization-server` lists no `registration_endpoint`.
- **Clients registered earlier stay usable.** A `client_id` that is not shaped
  like a metadata-document URL is looked up among stored registrations, in the
  `harper_oauth_mcp_clients` table of Harper's `oauth` database. Turning
  registration off does not remove those records: a client registered while
  registration was on can still sign people in and refresh tokens, and the host
  list below does not apply to it. Flair has no command that lists or removes
  these records; such a client stays usable until its record is deleted.
- **Listed hosts.** When `clientIdMetadataDocuments.allowedHosts` is non-empty,
  a `client_id` URL is accepted only if its host is on the list. For the
  document of an app that signs people in, an empty list (`[]`) or no
  `allowedHosts` key adds no allowlist restriction. The plugin still resolves
  the host before fetching and refuses one that resolves to an address outside
  the public ranges, such as a private, loopback or link-local address. A
  headless (`client_credentials`) document is refused unless the list is
  non-empty; with the shipped `config.yaml`, Flair's authorization server does
  not take that grant at all (see [example 5](#5-a-bot-reaches-another-oauth-protected-mcp-server-as-itself)).
  The shipped list, `claude.ai` and `claude.com`, is there for Claude. With a
  non-empty list, a `client_id` on any other host gets HTTP 400 from the
  authorization endpoint, with error `invalid_client` and the description
  `Unknown client_id`.
- **The person sees the app's host.** For an app that uses a metadata document,
  the authorization server shows a page naming the host of the app's
  `client_id` before it sends the person to the identity provider; the person
  continues from there.
- **Public clients with PKCE.** The document of an app that signs people in
  must declare `token_endpoint_auth_method: none`, or leave the field out. Any
  other value is refused with `invalid_client`. Every authorization request must
  carry a PKCE `code_challenge` with method `S256`. With the shipped
  `config.yaml`, the server's metadata advertises `none`, `client_secret_basic`
  and `client_secret_post` as token endpoint auth methods (the last two apply
  only to registered clients) and does not advertise `private_key_jwt`. Setting
  `mcp.clientCredentials.enabled: true`, which turns on the headless grant,
  changes the metadata: it then also lists `private_key_jwt`, the
  `client_credentials` grant type and `EdDSA` as the assertion signing
  algorithm. The document of an app that signs people in is still refused
  unless it declares `none` or leaves the field out.

### Changing the list

The list lives in `config.yaml`:

```yaml
'@harperfast/oauth':
  mcp:
    clientIdMetadataDocuments:
      allowedHosts:
        - claude.ai
        - claude.com
        - apps.example.com
```

Edit the `config.yaml` your instance runs (on Fabric, the one you deploy) and
restart Flair so the component loads the new list. The list is a literal in that
file, not an environment reference. The package ships the file with the default
list, and a completed upgrade installs the new version's file, so re-apply your
edit after upgrading.

`flair mcp enable --cimd-allowed-hosts <hosts>` can make this edit to
`config.yaml` in the current directory, else `~/.flair/config.yaml`, on the
machine where you run it. Without `--dry-run`, before any step that changes
anything, it refuses the flag unless a preflight match links the host and
process ID the instance reports, a readable process on this machine, and that
file (compared by `realpath`). At its `local-config-update` step, before it
restarts the instance, it writes the list unless the file already holds that
exact list, then reads the file back. It also refuses the flag for a Fabric
instance, an invalid host list, or a `config.yaml` that is missing, unreadable
or not valid YAML, has no `@harperfast/oauth` `mcp` mapping, or has a
`clientIdMetadataDocuments` that is not a mapping; it does not check early that
the file can be written, and a write failure fails the later
`local-config-update` step. A refusal changes nothing. With `--dry-run`, it
skips the match and writes nothing. A run that stops before
`local-config-update` does not write the list.
On Fabric, and whenever the command refuses, edit the file by hand as above. If
an upgrade replaces that file, run the command again or edit the file.

### ChatGPT

ChatGPT's published metadata document, `https://chatgpt.com/oauth/client.json`,
declares `token_endpoint_auth_method: private_key_jwt`. The `@harperfast/oauth`
version Flair pins, 2.5.0, accepts only `none` in the metadata document of an
app that signs people in, so ChatGPT's CIMD client is refused on 2.5.0 even with
`chatgpt.com` on the list. A sign-in that presents that document gets HTTP 400,
error `invalid_client`, and the description
`token_endpoint_auth_method 'private_key_jwt' is not supported for interactive CIMD clients; use 'none'`.
Stored registrations are a separate path (see [2. Which apps](#2-which-apps)),
and registration of new clients is off.

> **Upstream:** verification of `private_key_jwt` for interactive clients is in
> progress upstream in
> [HarperFast/oauth#245](https://github.com/HarperFast/oauth/pull/245).

## 3. What they can touch

A connection acts as its principal:

- **Writes** go under the principal's id. A non-admin principal cannot write a
  memory owned by another agent
  (`forbidden: cannot write memory owned by another agent`). The identity comes
  from the login's mapping, never from tool arguments.
- **Reads** cover the principal's own memories, of any visibility, and every
  other agent's memories on the instance that are not `private`. A non-admin
  principal does not get other agents' `private` memories. `flair grant` does
  not change this, because reads do not consult memory grants.
- **Admin** authority applies to a `/mcp` connection only when the principal's
  Agent record has `role: admin`. The principals that `flair mcp enable` and
  just-in-time provisioning create are not admins.

### Tokens

- With the shipped `config.yaml` (`accessTokenTtl: 900`), an access token from
  the authorization-code grant, or from refreshing one, lasts 900 seconds. When
  the headless `client_credentials` grant is enabled, its access tokens last
  300 seconds unless `mcp.clientCredentials.accessTokenTtl` is set. A request
  with an expired or invalid token gets HTTP 401 with
  error `invalid_token` and a `WWW-Authenticate: Bearer resource_metadata="…"`
  header.
- With the shipped `config.yaml`, which does not set
  `mcp.refreshTokenRequiresOfflineAccess`, the app also gets a refresh token
  unless its metadata lists grant types without `refresh_token`. When that
  option is set to true, the granted scope must also include `offline_access`.
  Refresh tokens are single-use: each refresh returns a
  new one. A refresh token that was already used is refused (`invalid_grant`),
  and the plugin attempts to revoke that sign-in's whole refresh-token family;
  if that revocation write fails, the failure is logged and the token is still
  refused. The family expires 30 days after the sign-in, the
  `@harperfast/oauth` default; the shipped `config.yaml` does not set
  `refreshTokenTtl`.

### Revoking access

Deactivate the principal, on the Flair host, with `FLAIR_ADMIN_PASS` set or
`--admin-pass`:

```bash
flair principal disable alice
```

When the operations API accepts the update, it prints
`✅ Principal 'alice' deactivated`.

- It sends an `update` to the operations API at `127.0.0.1` on the machine it
  runs on (port from `--ops-port`, `FLAIR_OPS_PORT` or the local Flair config).
  It has no option for a remote instance.
- The update sets the principal's `status` to `deactivated`, and its
  `updatedAt`, and nothing else: the principal's memories and its login mapping
  stay. The operations API of Harper 5.2.8, the version Flair pins, also accepts
  an update for an id that has no record, so the ✅ line does not show that the
  principal exists.
- Flair reads the principal's status on every `tools/call` for a known tool, and
  refuses those calls for a deactivated principal, including calls that carry a
  token issued before the change:

  ```json
  {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"forbidden: principal 'alice' is deactivated, so this token can no longer call tools. An operator must reactivate the principal (set its status to \"active\") to restore access."}}
  ```

- The same status refuses the principal's Ed25519-signed requests with HTTP
  401 `{"error":"principal_deactivated"}`.
- Disabling does not revoke OAuth tokens: they stay valid until they expire,
  and their tool calls are refused. Setting the status back to `active`
  restores access for tokens that are still valid. There is no
  `flair principal enable` command.

To close `/mcp` for everyone, unset `FLAIR_MCP_OAUTH` in the instance's
environment (or set it to `0`) and restart the instance; `flair mcp disable`
asks you to confirm the variable is unset, then sends the restart through the
instance's operations API.

## Check who you are

Call the `bootstrap` tool. Its structured result carries `agentId`, the
principal Flair resolved you to, and `scope`:

```json
"agentId": "alice",
"scope": { "agentId": "alice", "isAdmin": false, "reads": "own-and-org-non-private" }
```

If `agentId` is not the principal you expected, your login maps to a different
one (for example, one that just-in-time provisioning created); map it with
`flair mcp enable`. The stdio adapter's `bootstrap` returns text instead; an
agent can run `flair bootstrap --agent <id> --json` and read the same two
fields.

## Worked examples

The examples use placeholders: the instance `https://flair.example.com`, the
GitHub logins `alice`, `carol` and `dave`, the bot `bob-the-bot`, and another
MCP server at `https://mcp.acme.example`. `$TARGET_ADMIN_PASS` holds the
instance's admin password.

### People

#### 1. One person, one app: alice connects Claude

**Goal:** alice uses Claude with her hosted Flair, signs in with GitHub login
`alice`, and acts as principal `alice`.

Create a GitHub OAuth app whose callback URL is
`https://flair.example.com/oauth/github/callback` (the command prints this URL
too). Then run:

```bash
flair mcp enable \
  --instance https://flair.example.com \
  --idp-subject alice \
  --principal alice \
  --admin-pass "$TARGET_ADMIN_PASS"
```

When it finishes, it prints each step it ran, marked ✓ or ✗. The steps that
act:

- `signing-key` creates `~/.flair/mcp-signing-key.pem` (or the
  `--signing-key-file` path), or reuses the file if it exists.
- `idp-credentials` checks that the OAuth app's client id and secret are
  present; in a terminal, the command prompts for them before the steps run.
- `secrets-provisioning` always stages the secrets the instance needs in a local
  `0600` file. Without `--secrets-mechanism`, when the instance reports that it
  supports Harper's env-secrets, the step also attempts to push each secret, then
  reads back the stored row's `name` and `processEnv` flag (not the value). If
  a push fails, or its row cannot be read back or does not show `processEnv` as
  true, the step names the variables that failed and gives the staged-file
  instructions instead.
- `identity-mapping` writes the credential for `alice` and reads the login's
  credentials back (see [One mapping per login](#one-mapping-per-login)). The
  command then asks you to confirm that the secrets are applied to the instance
  (or takes `--confirm-secrets-applied`).
- `local-config-update` takes the first `config.yaml` it finds, in the current
  directory and then in `~/.flair/`, on the machine you run it on, and sets
  `mcp.enabled` to `${FLAIR_MCP_OAUTH}` when that file has the
  `'@harperfast/oauth'` → `mcp` block. When there is no such file or block, or
  the write fails, the step is marked failed and the command continues.
- `restart` sends a restart through the instance's operations API,
  `verify-restart` waits up to 30 seconds for a new process ID, and
  `self-verify` checks the published metadata; any of the three can fail the
  run.

On success it ends with:

```
✓ The OAuth metadata check passed. The /mcp route itself was not probed.

claude.ai → Settings → Connectors → Add custom connector
  URL: https://flair.example.com/mcp
  (no client ID to enter — Claude presents its own Client ID Metadata Document URL automatically)
```

On a `*.harperfabric.com` instance, the command ends at its
`fabric-operator-deploy` step instead, after the confirmation, and prints
instructions for finishing by hand. The step's own text says to apply the staged
secrets, which include `FLAIR_MCP_OAUTH=true`, to the instance's environment and
restart the instance. Afterwards,
`flair mcp status --instance https://flair.example.com` reports whether the
surface answers.

**Check:** in Claude, `bootstrap` returns `"agentId": "alice"` and
`"isAdmin": false` in `scope`.
**Revoke:** `flair principal disable alice` on the Flair host.

#### 2. The same person, a second app: shared or separate

**Goal:** alice also uses Claude Code on her laptop, and decides whether it
shares her connector's memories.

- **Through `/mcp`: shared, with no command.** Add
  `https://flair.example.com/mcp` to Claude Code as a remote HTTP MCP server.
  Claude Code's `client_id` is on `claude.ai`, which the shipped list allows. The
  mapping is per login, not per app, so when alice signs in with GitHub login
  `alice`, Claude Code acts as `alice`.
- **Through the stdio adapter: separate unless linked.** Register an agent for
  the laptop (as in [example 4](#4-a-bot-on-another-host-signs-with-its-own-key),
  say `alice-laptop`) and set `FLAIR_URL=https://flair.example.com` and
  `FLAIR_AGENT_ID=alice-laptop` in the adapter's config. `alice-laptop` and
  `alice` are then two principals: each writes its own memories and reads the
  other's non-private ones, and, neither being an admin, neither reads the
  other's `private` memories. To make them one, map the login to the laptop
  agent:

  ```bash
  flair mcp enable \
    --instance https://flair.example.com \
    --idp-subject alice --principal alice-laptop \
    --secrets-mechanism env-file \
    --admin-pass "$TARGET_ADMIN_PASS"
  ```

  Answer `n` when asked whether the staged secrets are applied. When the
  `identity-mapping` step shows ✓, its output says `re-pointed`. The
  connector's `bootstrap` then shows which principal it resolves to; it should
  be `"agentId": "alice-laptop"`. Memories already written as `alice` stay with
  `alice`.

**How to choose:** use one principal when both apps should see the same private
memories. Keep two when you want to revoke or audit them separately.
ChatGPT's CIMD client cannot be the second app yet; see [ChatGPT](#chatgpt).

**Check:** `bootstrap` in each app returns the `agentId` you chose.
**Revoke:** `flair principal disable` for the principal you want to stop.

#### 3. A small team, and someone leaves

**Goal:** alice, carol and dave each connect as their own principal. Later, dave
leaves.

Map alice as in example 1. Map each of the others on the running instance:

```bash
flair mcp enable \
  --instance https://flair.example.com \
  --idp-subject carol --principal carol \
  --secrets-mechanism env-file \
  --admin-pass "$TARGET_ADMIN_PASS"
```

Answer `n` when asked whether the staged secrets are applied; the
`identity-mapping` step has run by then (see
[Map a person to a principal](#map-a-person-to-a-principal)).
Repeat for `dave`. Each of them reads their own memories and the others'
non-private ones.

**Check:** `bootstrap` returns `"agentId": "carol"` for carol and
`"agentId": "dave"` for dave.

**Revoke:** when dave leaves, run `flair principal disable dave` on the Flair
host. His app may still hold an access token that passes the OAuth check until
it expires, but his next `tools/call` for a known tool gets:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"forbidden: principal 'dave' is deactivated, so this token can no longer call tools. An operator must reactivate the principal (set its status to \"active\") to restore access."}}
```

His memories stay, and those that are not `private` stay readable by alice and
carol.

### Bots

#### 4. A bot on another host signs with its own key

**Goal:** `bob-the-bot` runs on its own server and uses Flair with an Ed25519
key, the default for agents.

Run this on the bot's host, so that the private key is created where it is used:

```bash
flair agent add bob-the-bot \
  --target https://flair.example.com \
  --admin-pass-file ./target-admin-pass
```

The password file must be mode `0600`. For an `https` target on port 443, the
command sends the Agent record to the operations API on port 9925 of the <!-- docs-freshness-allow: hosted operations API port, not the data port -->
same host; pass `--ops-target <url>` if yours is elsewhere. It writes a new key
to `~/.flair/keys/bob-the-bot.key` (mode `0600`), or reuses the key already
there, sends an `insert` for the Agent record, and prints, among other lines:

```
✅ Agent 'bob-the-bot' (bob-the-bot) registered (ops: <operations API URL>)
```

If an Agent record with that id already exists, the insert leaves it unchanged,
including its public key (Harper 5.2.8, the version Flair pins, skips an insert
for an existing id), and the command still prints that line. Requests signed
with a key that does not match the stored one then get `invalid_signature`
(below).

Configure the stdio adapter (`@tpsdev-ai/flair-mcp`) on the bot's host with
`FLAIR_URL=https://flair.example.com` and `FLAIR_AGENT_ID=bob-the-bot`. With
`FLAIR_KEY_PATH` and `FLAIR_KEY_DIR` unset, it looks for the key at
`~/.flair/keys/bob-the-bot.key` and, when it finds it, signs each request it
sends to Flair with it:

```
Authorization: TPS-Ed25519 bob-the-bot:<unix-ms>:<nonce>:<base64 signature>
```

The signature is Ed25519 over `bob-the-bot:<unix-ms>:<nonce>:<METHOD>:<path>`,
where the path includes any query string. By default the timestamp must be
within 30 seconds of the server's clock, and a nonce is accepted once. A request
refused by these checks gets HTTP 401:

| Situation | Body |
|---|---|
| No Agent record with that id | `{"error":"unknown_agent"}` |
| Registered id, signed with a key that is not its registered key | `{"error":"invalid_signature"}` |
| Principal deactivated | `{"error":"principal_deactivated"}` |
| Timestamp outside the window | `{"error":"timestamp_out_of_window"}` |

**Check:** `flair bootstrap --agent bob-the-bot --url https://flair.example.com --json`
and read `agentId` and `scope`.
**Revoke:** `flair principal disable bob-the-bot` on the Flair host; its next
request gets `{"error":"principal_deactivated"}`.

`flair agent remove bob-the-bot`, also run on the Flair host, asks you to type
`yes` (or takes `--force`), then:

- searches the agent's `Memory` and `Soul` rows and sends a delete for each one
  it finds, without checking whether each delete succeeded;
- sends a delete for the `Agent` record, and stops with an error if the
  operations API rejects it;
- unless you pass `--keep-keys`, attempts to delete the agent's key files
  (private, public and `.bak`) from the keys directory on the machine it runs
  on, ignoring any failure;
- prints `Key files deleted.` (with `--keep-keys`,
  `Key files preserved (--keep-keys).`) and then
  `✅ Agent 'bob-the-bot' removed successfully`, without checking the Memory,
  Soul and key-file deletions.

Rows the agent owns in other tables, such as its workspace state, are left in
place.

#### 5. A bot reaches another OAuth-protected MCP server as itself

**Goal:** `bob-the-bot` calls the MCP server at `https://mcp.acme.example`
without a person signing in, using its Flair key as its client credential
(`client_credentials` with `private_key_jwt`).

When `FLAIR_MCP_ISSUER` or `FLAIR_PUBLIC_URL` is set, Flair publishes a Client
ID Metadata Document at `/MCPClientMetadata/<agent-id>` for an agent whose record
holds an Ed25519 public key (64 hex characters, or base64 that decodes to 32
bytes). With `FLAIR_MCP_ISSUER=https://flair.example.com`, the document for
`bob-the-bot` is served at
`https://flair.example.com/MCPClientMetadata/bob-the-bot`:

```json
{
  "client_id": "https://flair.example.com/MCPClientMetadata/bob-the-bot",
  "client_name": "bob-the-bot",
  "jwks": { "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "<public key>", "kid": "bob-the-bot" } ] },
  "token_endpoint_auth_method": "private_key_jwt",
  "grant_types": ["client_credentials"]
}
```

With neither variable set, the path answers HTTP 501 (`mcp_issuer_not_configured`).
For an unknown agent, or one with no public key, it answers HTTP 404
(`agent_not_found_or_no_key`). For a record whose public key does not decode to
32 bytes, it answers HTTP 500 (`invalid_agent_key`).

The other server's authorization server must allow this. If it runs
`@harperfast/oauth` 2.5.0, that includes `mcp.clientCredentials.enabled: true`
and `flair.example.com` in its `clientIdMetadataDocuments.allowedHosts`.

On the bot's host, mint a token:

```bash
flair mcp token --agent-id bob-the-bot \
  --client-id https://flair.example.com/MCPClientMetadata/bob-the-bot \
  --token-endpoint https://mcp.acme.example/oauth/mcp/token \
  --resource https://mcp.acme.example/mcp
```

It signs an EdDSA assertion with `iss` and `sub` set to the `client_id`, `aud`
set to the token endpoint, and a lifetime of at most 60 seconds, then sends the
token request. On success it prints
`access_token minted (<token type>, expires_in=<seconds>s):` followed by the
token, which the bot sends as `Authorization: Bearer <token>` to
`https://mcp.acme.example/mcp`. A `@harperfast/oauth` 2.5.0 server issues these
tokens for 300 seconds by default and no refresh token; mint another when it
expires.

Flair's own authorization server does not issue these tokens with the shipped
`config.yaml`, which has no `clientCredentials` block: it answers
`unsupported_grant_type`. This path is for reaching other servers.

**Check:** add `--dry-run` to sign the assertion and print its claims without
sending it, and fetch the metadata URL to see the published key.
**Revoke:** the other server's operator can remove `flair.example.com` from its
list. On Flair, the document remains served for a deactivated agent whose record
holds a valid Ed25519 public key, so `flair principal disable` does not withdraw
it. When `flair agent remove bob-the-bot` deletes the `Agent` record, the path
answers 404. An authorization server that fetched the document earlier can keep
using its cached copy until that copy expires.

#### 6. A bot and a person using the same app

**Goal:** alice runs Claude Code herself, and a nightly job runs Claude Code on a
build server. The job gets its own principal.

Register the job's agent as in example 4 and set
`FLAIR_URL=https://flair.example.com` and `FLAIR_AGENT_ID=bob-the-bot` in the
build server's MCP config. Do not copy alice's key to the server or set
`FLAIR_AGENT_ID=alice` there.

Why a separate principal:

- **Attribution.** The job's writes carry `bob-the-bot`. As a non-admin agent,
  it cannot write a memory owned by `alice`.
- **Privacy.** alice's `private` memories are not returned to `bob-the-bot`, and
  the bot's `private` memories are not returned to alice (neither is an admin).
  Non-private memories are readable by both. A `memory_store` without a
  `visibility` and with the default `standard` durability is `private`.
- **Revocation.** `flair principal disable bob-the-bot` gets the job's requests
  refused and leaves alice working. A job that runs as `alice` cannot be cut
  off without cutting off alice too.

What the bot reads follows [What they can touch](#3-what-they-can-touch): its
own memories and other agents' non-private ones. `flair grant` does not narrow
that, because reads do not consult memory grants.

**Check:** `flair bootstrap --agent bob-the-bot --url https://flair.example.com --json`
on the build server returns `"agentId": "bob-the-bot"` and `"isAdmin": false`
in `scope`.
**Revoke:** `flair principal disable bob-the-bot` on the Flair host.
