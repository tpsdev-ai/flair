# Flair CLI

## Status
- **Owner:** Flint
- **Priority:** P1 — load-bearing UX for Flair 1.0
- **Context:** Design session with Nathan 2026-04-08
- **Reviewers:** Kern (architecture), Sherlock (security) — pending
- **Composes with:** FLAIR-PRINCIPALS, FLAIR-FEDERATION, FLAIR-WEB-ADMIN

## Summary

`flair` is the canonical entry point for everything Flair. Users install it once, and every operation — from first-time setup to daily memory queries to federation pairing to credential management — happens through `flair` subcommands. The CLI wraps Harper CLI internally; users never type `harper deploy`, `harper set_configuration`, or any other Harper command directly.

This spec defines the full CLI surface, configuration layout, the bundled Harper Core installation model, local keychain usage, and the flow-level UX for initial setup, deployment to Fabric, and day-to-day operations.

**Key principles:**

1. **Flair CLI is the only surface the user touches.** Harper is plumbing.
2. **Defaults to local.** First run without any flags sets up a working local Flair instance.
3. **One command per user intent.** Multi-step flows with token-juggling are failures. If an operation needs the CLI to do five things under the hood, the CLI does all five under one command.
4. **Secrets never appear in shell history or stdout.** Passphrases, bootstrap tokens, bearer tokens — all stored in the local OS keychain, displayed only via explicit confirmation-gated commands.
5. **Same command surface regardless of topology.** `flair memory search "query"` works identically whether the instance is local, federated, or standalone-hosted.

---

## 1. Distribution and Installation

### Package layout

The Flair product ships as a single installable package containing:

- **`flair` CLI binary** — the command entry point
- **Vendored Harper Core** — a specific version of Harper Core bundled with Flair
- **`flair` Harper component** — the Flair app (resources, endpoints, sync, OAuth) as a Harper component that runs under Harper Core

This is Nathan's choice (option C from the design discussion): bundle Harper Core inside Flair rather than requiring users to install Harper separately. Trade-offs explicitly accepted:

- Flair is coupled to a specific Harper version at each release. We bump the vendored version deliberately.
- Package size is larger than a thin CLI. Acceptable for a single-install product.
- Fabric deploys are unaffected — Fabric provides its own Harper, and `flair deploy` just pushes the `flair` Harper component to Fabric's existing runtime.

### Install channels

- **Homebrew** (`brew install flair`) for macOS — primary distribution for Nathan's use case
- **npm** (`npm i -g flair`) — alternative for environments with Node already installed
- **Direct download** — single binary (via `pkg`-style bundler) for bootstrapping on a fresh machine

All three install channels produce the same CLI surface.

### Install locations

- Binary: `/opt/homebrew/bin/flair` (or equivalent)
- Bundled Harper Core: `~/.flair/runtime/harper-core/` (extracted on first use, not at install time, to keep install fast)
- Data directory: `~/.flair/data/` (Harper's data dir for the local instance, if running local mode)
- Config: `~/.flair/config.yaml`
- Logs: `~/.flair/logs/`
- Keychain items: stored under the service name `ai.lifestylelab.flair` in the OS keychain

---

## 2. First-Time Setup

The most important UX surface. This is Nathan's first impression of the product.

### `flair init`

Default — sets up a local Flair instance.

```
$ flair init
Welcome to Flair.

Setting up your local memory store...
  ✓ Extracted Harper Core (v5.0.0-beta.6)
  ✓ Initialized data directory at ~/.flair/data
  ✓ Generated instance keypair
  ✓ Stored passphrase in keychain (ai.lifestylelab.flair.instance_passphrase)
  ✓ Created admin principal "nathan" (or whatever the OS user is)
  ✓ Started local Flair at http://localhost:19926

You're ready. Try: flair memory write "my first memory"

Next steps:
  • flair principal show             Show your admin principal
  • flair instance passphrase show   Back up your instance passphrase (recommended!)
  • flair pair add --hub ...         Federate with a remote Flair instance
```

**What happens under the hood:**
1. Check if `~/.flair/config.yaml` exists — if yes, print "already initialized, use `flair status`" and exit
2. Extract the bundled Harper Core to `~/.flair/runtime/harper-core/` if not already there
3. Start Harper Core as a managed subprocess (or daemon via launchd / systemd / service — see § 5)
4. Auto-generate a 32-byte random passphrase and store it in the OS keychain
5. Start the `flair` Harper component against the local Harper
6. Via Flair's own internal API: generate an Ed25519 instance keypair, encrypt the private key with a key derived from the passphrase (Argon2id + AEAD), store it in a Harper blob
7. Via Flair's own internal API: create the admin Principal using the current OS user's name as display name (still needs WebAuthn registration — see Flow below)
8. Write `~/.flair/config.yaml` with mode=local, role=standalone
9. Print the success message

### `flair init --remote fabric://<cluster>`

Alternative — deploys Flair to Harper Fabric instead of running locally.

```
$ flair init --remote fabric://mycluster.harper.fabric
Welcome to Flair.

Setting up your remote memory store on Fabric...
  → Enter your Fabric username: nathan
  → Enter your Fabric password: ********
  → Storing Fabric credentials in keychain...

Deploying Flair to mycluster.harper.fabric...
  ✓ Packaged flair component
  ✓ harper deploy completed
  ✓ Generated instance passphrase (backed up to your keychain)
  ✓ Generated instance keypair (stored in Harper blob on the cluster)
  ✓ Admin principal created
  ✓ Flair online at https://mycluster.harper.fabric

Next steps:
  • flair memory write "my first memory"
  • flair instance passphrase show   Back up your instance passphrase (critical for recovery)
  • flair pair add --hub ...         Add a local Flair instance as a spoke
```

**What happens under the hood:**
1. Prompt for Fabric credentials, store in OS keychain under `ai.lifestylelab.flair.fabric_<cluster>`
2. Package the `flair` Harper component (from the vendored copy inside the CLI)
3. Invoke `harper deploy target=https://<cluster>.harper.fabric project=flair package=<path> username=<u> password=<p> restart=true replicated=true`
4. Wait for deploy to complete
5. Auto-generate instance passphrase, store in local keychain, then push it to Fabric via `harper set_configuration ... flair.instance_key_passphrase=<value>` and immediately restart the Flair service so it picks up the config
6. Call Flair's admin endpoint (authenticated via deploy credentials) to trigger instance key generation — Flair reads the passphrase from config, generates the Ed25519 keypair, encrypts and stores in a Harper blob, clears the passphrase config value
7. Create admin principal via an API call
8. Write `~/.flair/config.yaml` with mode=remote, target=`https://<cluster>.harper.fabric`
9. Print the success message

### `flair init --hybrid`

Reserved future flag for setting up a local instance AND deploying a remote one in a single command, with auto-pairing. Not 1.0.

---

## 3. Admin Principal and Passkey Registration

`flair init` creates the admin principal record but does not yet bind a WebAuthn credential. Before the principal is usable, Nathan needs to register a passkey.

Two flows, depending on whether this is local or remote:

### Local: browser-based passkey registration

```
$ flair init
...
✓ Created admin principal "nathan"
✓ Opening browser to register your passkey...

[browser opens to http://localhost:19926/setup/<one-time-token>]
[Nathan completes WebAuthn ceremony with Touch ID / Face ID / security key]

✓ Passkey registered
Nathan, you're ready.
```

The claim/setup page is served by the local Flair instance; the browser opens automatically to the setup URL with a one-time claim token that's valid for 10 minutes. Same flow as standalone hosted cold-start from FLAIR-PRINCIPALS, just with a localhost URL.

### Remote: browser-based passkey registration via the Fabric-hosted endpoint

```
$ flair init --remote fabric://mycluster.harper.fabric
...
✓ Admin principal created
✓ Opening browser to register your passkey...

[browser opens to https://mycluster.harper.fabric/setup/<one-time-token>]
[Nathan completes WebAuthn ceremony]

✓ Passkey registered
Nathan, you're ready.
```

Same flow, remote URL. The passkey is registered against the Flair instance running on Fabric.

**Offline fallback:** if the browser doesn't open automatically (CI, SSH session, headless machine), the CLI prints the setup URL and exits with code 2:

```
Could not open a browser automatically. Complete registration by visiting:

  https://mycluster.harper.fabric/setup/9f3a-b7c2-1d4e-8a5f

The link expires in 10 minutes.
```

---

## 4. Command Reference

### Instance management

```bash
flair init                                  # set up local Flair (default)
flair init --remote fabric://<cluster>     # deploy to Fabric instead
flair init --local                          # explicit local (same as no flag)

flair status                                # show current config, running state, peers
flair stop                                  # stop the local Flair daemon (no-op for remote)
flair start                                 # start the local Flair daemon (no-op for remote)
flair restart                               # restart

flair upgrade                               # upgrade to a newer Flair CLI version
                                            # — also upgrades bundled Harper Core if needed
flair uninstall                             # stop daemons, remove data, clear keychain (with confirmation)
```

### Secrets and keychain

```bash
flair instance passphrase show              # reveal the instance passphrase (for backup)
                                            # Requires confirmation prompt:
                                            #   "This reveals your instance passphrase.
                                            #    Anyone with this value can decrypt your
                                            #    instance private key. Continue? [y/N]"
                                            # Prints once, requires explicit copy.

flair instance passphrase rotate            # generate a new passphrase, re-encrypt the blob
                                            # Useful after a suspected exposure.

flair remote login <target>                 # prompt for and store Fabric credentials in keychain
flair remote logout <target>                # remove Fabric credentials for a target
flair remote list                           # list known remote targets with stored credentials
```

### Principals (see FLAIR-PRINCIPALS for semantics)

```bash
flair principal create [--kind human|agent] [--display-name <name>]
flair principal list [--kind human|agent] [--status active|deactivated]
flair principal show <id>
flair principal update <id> [--display-name <name>] [--add-subject <s>] [--remove-subject <s>]
flair principal deactivate <id>
flair principal reactivate <id>
flair principal purge <id>
```

### Credentials

```bash
flair credential create <principal-id> --kind webauthn|bearer-token|ed25519 --label <label>
flair credential list <principal-id>
flair credential show <credential-id>
flair credential revoke <credential-id>
```

### Memory

```bash
flair memory search <query> [--limit N] [--subject <s>] [--agent <id>]
flair memory write <content> [--subject <s>] [--tags a,b,c] [--durability standard|persistent|permanent|ephemeral]
flair memory read <id>
flair memory update <id> [--content <new>] [--add-tags a,b] [--durability ...]
flair memory supersede <old-id> <new-content>    # creates a new memory that supersedes the old one
flair memory delete <id>                          # soft delete via tombstone
```

### Soul (per-principal metadata)

```bash
flair soul get --agent <id>
flair soul set --agent <id> --key <key> --value <value>
flair soul unset --agent <id> --key <key>
```

### Federation (see FLAIR-FEDERATION)

```bash
flair pair add --hub <endpoint>             # one-command pairing as a spoke
                                            # Under the hood: generates bootstrap token,
                                            # pushes it to the hub via harper set_configuration,
                                            # calls /pair, pins keys.
flair pair list                             # list configured peers
flair pair revoke <peer-id>                 # disconnect and unpair
flair pair status [--peer <id>]             # show sync state per peer

flair sync status                           # show per-peer per-principal replication lag
flair sync pause <peer-id>                  # temporarily halt sync with a peer
flair sync resume <peer-id>
```

### Deployment (Fabric)

```bash
flair deploy --target fabric://<cluster>    # initial deploy (first-time, via init flow)
flair deploy --target fabric://<cluster> --upgrade   # upgrade an existing Fabric deployment
flair deploy logs --target fabric://<cluster>        # tail logs via harper read_log
```

### OAuth client management (admin)

```bash
flair oauth client list
flair oauth client show <client-id>
flair oauth client revoke <client-id>
flair oauth session list [--principal <id>]
flair oauth session revoke <session-id>
```

---

## 5. Running Flair Locally — The Managed Daemon

When `flair init` runs in local mode, it starts the bundled Harper Core + flair component as a managed background process. The user doesn't see a Harper process — they see `flair` running.

### macOS (primary)

`flair init` installs a launchd plist at `~/Library/LaunchAgents/ai.lifestylelab.flair.plist` that:

- Runs `~/.flair/runtime/harper-core/bin/harper start --component flair` (or equivalent)
- `KeepAlive: true`
- `RunAtLoad: true`
- Environment variables for Flair config, data dir, log paths
- Stdout/stderr to `~/.flair/logs/flair.log` and `~/.flair/logs/flair.err.log`

`flair stop` / `flair start` / `flair restart` invoke `launchctl kickstart -k gui/$UID/ai.lifestylelab.flair` and equivalents.

### Linux

Systemd user service at `~/.config/systemd/user/flair.service` doing the equivalent. `flair start/stop/restart` wrap `systemctl --user`.

### Windows

Initially unsupported for 1.0. Windows support is a 1.x item.

### Port

Local Flair binds to `localhost:19926` by default. Configurable via `~/.flair/config.yaml` under `local.port`. Flair never binds to `0.0.0.0` in local mode — if someone wants to expose their local Flair, they do it through federation (pair with a hub), not by rebinding.

---

## 6. Configuration File

`~/.flair/config.yaml`:

```yaml
# Flair local configuration
#
# This file is managed by `flair init` and friends. Edit by hand only if you
# know what you're doing. `flair config set <key> <value>` is safer.

mode: local                     # local | remote
role: standalone                # standalone | hub | spoke

# Local mode (when mode: local)
local:
  port: 19926
  data_dir: ~/.flair/data
  harper_dir: ~/.flair/runtime/harper-core

# Remote mode (when mode: remote)
remote:
  target: https://mycluster.harper.fabric
  # Credentials are NOT in this file. They're in the OS keychain under
  # ai.lifestylelab.flair.fabric_<cluster-slug>.

# Federation (when role is hub or spoke)
peers:
  - id: flair_rockit_a1b2
    endpoint: wss://mycluster.harper.fabric/sync
    public_key: "base64url..."      # pinned at pairing time
    role: hub
    subject_subscriptions: all

# CLI preferences
cli:
  default_editor: vim             # for flair memory write --interactive
  color: auto                     # auto | always | never
  log_level: info
```

Configuration management:

```bash
flair config show                           # print current config
flair config get <key>                      # get a specific value (e.g. local.port)
flair config set <key> <value>              # set a value, writes the file safely
flair config unset <key>                    # remove a value
flair config edit                           # opens $EDITOR for manual edit
```

---

## 7. Keychain Usage

The Flair CLI uses the OS keychain for any secret it needs to remember between commands:

| Keychain key | What it is | Who reads it |
|---|---|---|
| `ai.lifestylelab.flair.instance_passphrase` | Local or remote instance passphrase (used to decrypt the instance private key blob in Harper) | `flair init`, `flair deploy`, `flair instance passphrase show`, `flair instance passphrase rotate` |
| `ai.lifestylelab.flair.fabric_<cluster-slug>` | Fabric deploy username + password | `flair remote login/logout`, `flair deploy --target fabric://<cluster>` |
| `ai.lifestylelab.flair.bootstrap_token_<peer-id>` | Ephemeral bootstrap token during a pair flow, cleared after success | `flair pair add` |

### Passphrase show flow

```
$ flair instance passphrase show

⚠  This will display your Flair instance passphrase in plaintext.
⚠  Anyone with this value can decrypt your instance private key,
⚠  which means they can impersonate this Flair instance to its peers.
⚠
⚠  Only use this to back up the passphrase to a secure location
⚠  (1Password, a hardware-encrypted USB, a printed copy in a safe).
⚠
⚠  The passphrase will be shown once. No re-display.

Continue? [y/N] y

  Passphrase: xVpR-8k2L-qMNc-7Hfj-9dWa-1eTz

Please copy it now. This command will not display it again.
```

No `--copy-to-clipboard` flag because clipboards leak. No `--save-to-file` flag because files leak. Nathan copies manually and stores wherever he decides.

### Platform fallback

On systems without a native keychain (some Linux servers), the fallback is `~/.flair/secrets.gpg` — a GPG-encrypted file using a passphrase derived from a runtime-prompted value. This is not the primary path; it exists so Flair can run on headless servers without a keychain daemon.

---

## 8. UX Flows (Nathan-Grade)

### Flow 1: I want to use Flair locally, zero prior setup

```
$ brew install flair
[homebrew output]

$ flair init
Welcome to Flair.

Setting up your local memory store...
[60 seconds of setup steps]

Your Flair instance is ready. Open this URL to register your passkey:

  http://localhost:19926/setup/9f3a-b7c2-1d4e-8a5f

[browser auto-opens]
[Nathan registers passkey via Touch ID]

✓ Passkey registered for nathan (usr_nathan_a7f3)
✓ Flair is running at http://localhost:19926

Try: flair memory write "hello, memory"
```

**Anti-goals:**
- Asking whether Nathan wants local or remote before doing anything
- Making Nathan pick a port
- Offering configuration options before he has a working instance
- Any step that requires typing a password

### Flow 2: I want to add Fabric as a hub for my local Flair

Assume Flow 1 is done. Now Nathan wants his local rockit Flair to federate with a Fabric-hosted hub he already has.

```
$ flair remote login fabric://mycluster.harper.fabric
Fabric username: nathan
Fabric password: ********
✓ Credentials stored in keychain

$ flair pair add --hub https://mycluster.harper.fabric
Preparing to pair with mycluster.harper.fabric...
  ✓ Generated bootstrap token
  ✓ Pushed token to hub via harper set_configuration
  ✓ Called /pair endpoint
  ✓ Pinned hub public key
  ✓ Cleared bootstrap token from hub config
  ✓ Opened sync channel

Your local Flair is now a spoke of https://mycluster.harper.fabric.
Sync will begin immediately.
```

**Anti-goals:**
- Making Nathan generate a token himself
- Making Nathan paste the token anywhere
- Multiple steps with "now do this, now do that"
- Any step that mentions `harper set_configuration`

### Flow 3: I need to back up my instance passphrase

Flow 1 is done; Nathan remembers the `flair instance passphrase show` recommendation and runs it.

```
$ flair instance passphrase show

⚠  This will display your Flair instance passphrase in plaintext.
[warning text]

Continue? [y/N] y

  Passphrase: xVpR-8k2L-qMNc-7Hfj-9dWa-1eTz

Please copy it now. This command will not display it again.
```

Nathan copies to 1Password or wherever. Done.

**Anti-goals:**
- Auto-copying to clipboard
- Writing to a file
- Emailing it (lol)
- Showing without confirmation

### Flow 4: I lost my passphrase and need to reset

```
$ flair instance passphrase rotate

⚠  Rotating the instance passphrase regenerates the key that protects
⚠  your instance private key. The old passphrase will be invalidated.
⚠
⚠  You will need to re-pair any spokes that were previously paired with
⚠  this instance (their pinned keys stay valid, but the passphrase you
⚠  backed up is now wrong — update your backups).

Continue? [y/N] y

✓ Generated new passphrase
✓ Re-encrypted instance private key blob
✓ Updated keychain

Please back up the new passphrase:
  $ flair instance passphrase show
```

**Anti-goals:**
- Silently rotating without warning about spoke re-pairing
- Rotating without warning that backups need updating

### Flow 5: I accidentally ran `flair init` twice

```
$ flair init
Flair is already initialized on this machine.

  Mode: local
  Status: running (PID 42314)
  Listening: http://localhost:19926
  Admin principal: usr_nathan_a7f3

Use `flair status` for more detail or `flair reset` to wipe and start over.
```

**Anti-goals:**
- Silently re-initializing (destroys existing data)
- Prompting to overwrite
- Hanging waiting for input

### Flow 6: I'm upgrading Flair

```
$ flair upgrade
Checking for updates...
  Current: flair 1.0.0 (Harper Core v5.0.0-beta.6)
  Latest:  flair 1.0.3 (Harper Core v5.0.0)

Upgrade will:
  ✓ Install flair 1.0.3
  ✓ Extract Harper Core v5.0.0
  ✓ Stop the current Flair daemon
  ✓ Migrate data (none required for this upgrade)
  ✓ Restart the daemon

Continue? [y/N] y

✓ Done. Flair 1.0.3 is running.
```

---

## 9. Things Nathan Would Hate If We Built Them This Way

1. **Asking `local or remote?` as the first setup question.** Default to local; offer `--remote` as an explicit flag. Prompting forces a decision before the user has context.
2. **Showing Harper in the output.** The user doesn't care that Harper exists. If we surface "starting harperdb..." during `flair init`, we've failed at abstraction. Log it to a debug stream, not stdout.
3. **Any command that prints a token/secret without a confirmation gate.** `flair instance passphrase show` is the ONLY command that displays a secret, and it's gated behind an explicit warning.
4. **Config values that have to be edited by hand in YAML.** Every config knob should have a `flair config set <key>` equivalent. The YAML file is the backing store, not the interface.
5. **Requiring the user to install Harper separately.** Bundled Harper Core is the whole point. If `flair init` fails with "Harper not found, run `brew install harperdb`," we've made them do OUR job.
6. **`flair deploy` with twelve required flags.** Use credentials from the keychain, use config from `~/.flair/config.yaml`, prompt only for values that truly can't be inferred.
7. **Silently overwriting existing data on re-init.** Flow 5 exists for a reason. Destruction is an explicit `flair reset` command with its own confirmation.
8. **Uncolored or uninformative progress output.** Each step in `flair init` needs to be visible so Nathan knows what's happening. "Setting up... done" is not enough; "✓ Extracted Harper Core" is.
9. **CLI responses that say "Operation completed successfully."** Tell the user what happened in concrete terms. "Passkey registered for usr_nathan_a7f3" is useful. "Operation completed successfully" is noise.
10. **`flair help` that dumps 300 lines of subcommand output.** Progressive disclosure: `flair help` shows top-level commands with one-liner descriptions. `flair <command> help` shows that command's details.

---

## 10. Implementation Phasing

**Phase 1 — Skeleton CLI**
- Subcommand routing structure
- `flair version`, `flair help`, `flair status`
- Config file reading and writing
- Keychain integration (macOS first)

**Phase 2 — Local mode**
- Bundled Harper Core extraction
- `flair init` (local default)
- launchd plist generation and management
- `flair stop/start/restart`
- Admin principal creation with browser-based passkey registration

**Phase 3 — Memory and principal commands**
- `flair memory` subcommands wiring to Flair's HTTP API
- `flair principal` subcommands wiring to Flair's HTTP API
- `flair credential` subcommands wiring to Flair's HTTP API
- `flair soul` subcommands

**Phase 4 — Remote deployment**
- `flair remote login/logout/list`
- `flair init --remote fabric://...`
- `flair deploy --target fabric://... --upgrade`
- `harper deploy` invocation wrapping
- `harper set_configuration` invocation wrapping

**Phase 5 — Federation**
- `flair pair add/list/revoke`
- `flair sync status/pause/resume`
- Bootstrap token flow (generate locally, push to hub, pair, clean up)

**Phase 6 — Secret management and polish**
- `flair instance passphrase show/rotate`
- Confirmation prompts and warning text
- Progress output polish
- Colored/uncolored output
- Error message polish

**Phase 7 — Distribution**
- Homebrew formula
- npm package
- Direct download binary (pkg-style bundling of bun + harper)
- Release automation

Phases 1-3 give a working local-only Flair with memory operations. Phase 4 adds Fabric deployment. Phase 5 connects federation. Phase 6 hardens UX. Phase 7 packages for distribution.

---

## 11. Out of Scope for 1.0

- **Windows support.** 1.x item.
- **Interactive TUI** (`flair tui` opening a terminal UI). Out of scope; CLI subcommands are the 1.0 surface.
- **Scripting API / JSON output mode.** All commands print human-readable output in 1.0. Machine-readable (`--json`) output is a nice-to-have for 1.1 when someone writes a shell script that wraps Flair.
- **Plugin architecture for custom commands.** The CLI is fixed in 1.0.
- **Multi-profile support** (running multiple independent Flair instances on the same machine under different profiles). 1.0 assumes one Flair per user per machine.

---

## 12. References

- FLAIR-PRINCIPALS — principal/credential data model
- FLAIR-FEDERATION — federation protocol that `flair pair` commands wrap
- FLAIR-WEB-ADMIN — web UI for admin operations (the CLI is primary, web is a supplementary surface)
- Harper CLI docs — the underlying commands Flair CLI wraps
