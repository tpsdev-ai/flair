# Secrets and keys

Flair owns **identity**. Flair does **not** own arbitrary secrets. This page draws the line and shows you how to wire both into your agent setup without leaking anything into shell history, repo configs, or process arguments.

## What Flair owns: agent identity (Ed25519)

For each registered agent, Flair stores:

- A **public key** in the `Agent` table (server-side; used to verify signed requests).
- A **private key** at `~/.flair/keys/<agent>.key` on the host that owns that agent (PKCS8 base64). Created by `flair agent add <id>`. Mode `0600`.

Agents sign every request to Flair with this key. Flair refuses unsigned requests and refuses signatures that don't match the registered public key. The signed payload is `<agentId>:<timestamp>:<nonce>:<METHOD>:<path>` with a 30-second replay window and nonce dedup — replays inside that window are rejected.

**This is the only secret material Flair manages.** Lose the key file and the agent is locked out (`flair agent rotate <id>` to issue a new pair).

## Flair admin password (Harper instance)
- If not provided via `--admin-pass`, `--admin-pass-file`, `FLAIR_ADMIN_PASS`, or `HDB_ADMIN_PASSWORD`, a random password is generated and written to `~/.flair/admin-pass` (mode `0o600`). The password is **not** printed to the console.
- The `--admin-pass-file <path>` option allows reading the password from a file (for pre-staged secrets).
- The `--admin-pass <pass>` option is deprecated due to shell history exposure; use `--admin-pass-file` or environment variables instead. A warning is printed when this option is used.
- Environment variables `FLAIR_ADMIN_PASS` and `HDB_ADMIN_PASSWORD` are also supported.
## What Flair does *not* own: API keys, tokens, third-party credentials

Things that are NOT Flair's job:

- LLM provider API keys (Anthropic, OpenAI, Gemini, DeepSeek, Ollama Cloud, etc.)
- Database connection strings
- Cloud provider credentials (AWS, GCP, Azure)
- GitHub PATs, GitLab tokens, npm publish tokens
- Webhook URLs containing secrets (Discord, Slack, etc.)
- Anything else your agent needs to talk to the rest of the world

These belong in your **OS keyring** (macOS Keychain, Linux secret-service, Windows Credential Manager) or a dedicated secrets manager (1Password, HashiCorp Vault, age-sops, AWS Secrets Manager). Flair stays focused on what it's good at — identity and memory — and inherits the OS-level security model for everything else.

## Patterns for wiring secrets into agent CLIs

The general principle: **never put a secret in a config file checked into a repo, never pass one as a command-line argument, never `echo $SECRET` in a shell that has history**. Read it at process-start from the OS keyring or an env-only source, and pass it through the env to the child process.

### macOS — Keychain

Store once via the Keychain Access app, or:

```bash
security add-generic-password -a "$USER" -s "anthropic-api-key" -w "sk-ant-..."
# read at use:
security find-generic-password -a "$USER" -s "anthropic-api-key" -w
```

In your `.mcp.json` / `~/.gemini/settings.json` / `~/.codex/config.toml`, reference an env var (don't put the secret literal). Then export the env var from a shell wrapper that reads from Keychain at start:

```bash
# ~/.config/agent-env.sh — sourced by your shell rc, NOT checked into git
export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s "anthropic-api-key" -w)"
export OPENAI_API_KEY="$(security find-generic-password -a "$USER" -s "openai-api-key" -w)"
export GEMINI_API_KEY="$(security find-generic-password -a "$USER" -s "gemini-api-key" -w)"
```

Then your agent CLI configs can reference `${ANTHROPIC_API_KEY}` etc. by name.

### Linux — secret-service (GNOME Keyring / KWallet via libsecret)

```bash
# Store
secret-tool store --label="Anthropic API Key" service anthropic-api-key
# (paste the secret when prompted)

# Read
secret-tool lookup service anthropic-api-key
```

Same wrapper-script pattern: read from `secret-tool` in `~/.config/agent-env.sh`, export as env vars.

### 1Password CLI (cross-platform, recommended for teams)

1Password's `op` CLI gives you reproducible secret-loading in scripts and CI:

```bash
op signin

# Read at use
ANTHROPIC_API_KEY="$(op item get "Anthropic" --field credential --reveal)"
```

For agent CLI configs, run them under `op run`, which substitutes `op://` references at process-start without ever touching disk:

```bash
op run --env-file=.env.agent -- claude
```

Where `.env.agent` (checked-in-able, just references — no secrets) contains:

```
ANTHROPIC_API_KEY=op://Personal/Anthropic/credential
OPENAI_API_KEY=op://Personal/OpenAI/credential
```

### age + sops (for repo-checked-in encrypted secrets)

If you must store secrets in a repo (e.g. a deployment config that includes a webhook URL), encrypt them with [sops](https://github.com/getsops/sops) using [age](https://github.com/FiloSottile/age) keys. Decrypt at deploy time, never in source.

```bash
# Encrypt a secrets file
sops --age $(cat ~/.config/sops/age/keys.txt | grep public | cut -d' ' -f4) \
     --encrypt --in-place secrets.env

# At process start
sops --decrypt secrets.env > /tmp/.env.runtime && \
  set -a && . /tmp/.env.runtime && set +a && \
  shred -u /tmp/.env.runtime
```

## Wiring keys into the major agent CLIs

The pattern is identical across CLIs: the CLI config references env var names, your shell wrapper exports those env vars from the OS keyring at start. **The CLI config never holds the secret literal.**

### Claude Code

`claude` reads `ANTHROPIC_API_KEY` from the env. Set it via the wrapper-from-Keychain pattern above; never `claude --api-key sk-ant-...` (writes to shell history).

The flair-mcp server (`@tpsdev-ai/flair-mcp`) reads `FLAIR_AGENT_ID` and (optionally) `FLAIR_KEY_PATH` from its own env block in `.mcp.json`. The Flair private key isn't a "secret" you load from Keychain — it's a key file that already lives at a fixed path with `0600` mode, owned by Flair.

### Gemini CLI

`gemini` reads `GEMINI_API_KEY` (or `GOOGLE_API_KEY` depending on the auth mode) from the env. Same wrapper pattern.

For the flair-mcp server: in `~/.gemini/settings.json`, the `mcpServers.flair.env` block declares `FLAIR_AGENT_ID`, but the value is just a string (the agent id, not a secret).

### OpenAI Codex CLI

`codex` reads `OPENAI_API_KEY` from the env. Same wrapper pattern.

For the flair-mcp server: in `~/.codex/config.toml`, the `[mcp_servers.flair.env]` table declares `FLAIR_AGENT_ID` (just a string).

### Hermes (Nous Research)

Hermes uses `~/.hermes/.env` for provider API keys (managed by `hermes auth`). The Flair plugin (`packages/hermes-flair/`) reads `FLAIR_AGENT_ID` and `FLAIR_KEY_PATH` from env or `$HERMES_HOME/flair.json`. Per the plugin's own `get_config_schema()`, secret fields go to `.env`, non-secret fields go to JSON.

## What to do with the Flair private key itself

`~/.flair/keys/<agent>.key` is the only secret Flair generates. Treat it like an SSH private key:

- **Stays on the host that owns the agent.** If your agent runs on rockit, the key lives on rockit. If you spin up the same agent on another machine, **don't copy the key** — register a new agent identity (`flair agent add <id>-on-<other-host>`) on that machine. Different identities, same Flair instance can store memories for both, you decide cross-agent visibility.
- **`chmod 600` enforced** by `flair agent add`. Don't relax it.
- **Don't check it into git.** `.gitignore` should already exclude `~/.flair/keys/`; if you're ever tempted to share keys for "convenience," rotate first (`flair agent rotate <id>`).
- **Backup separately**, encrypted. The `flair backup` command excludes private keys by default. Roll your own backup of `~/.flair/keys/` via age-encrypted archive if you want offsite recovery.

## What about a `flair secret` CLI?

Considered, deferred. Flair could ship a thin wrapper around the OS keyring (`flair secret get/set/list`) — but the OS primitives already work and are universally trusted. Adding a Flair-shaped wrapper would mean we own the bug surface for marginal ergonomic gain. Better path: document the OS primitives well (this page) and stay focused on identity + memory.

If you find yourself wanting one anyway, your agent can call `security find-generic-password` / `secret-tool lookup` / `op read` directly — no Flair involvement needed.

## Threat model summary

| Asset | Owned by | If compromised → |
|---|---|---|
| Flair agent private key (`~/.flair/keys/<agent>.key`) | Flair (you, on the host) | Attacker can read/write that agent's memories until you rotate. Use `flair agent rotate <id>`. Other agents unaffected. |
| LLM provider API keys (Anthropic, OpenAI, etc.) | OS keyring / 1Password | Standard provider revocation: rotate the key in the provider's console, update keyring entry. |
| Cross-host secrets (1Password vault, age-sops) | The secret manager itself | Trust falls back to that manager's MFA / key handling. Document recovery in your team's ops runbook. |
| Memory contents | Flair (server-side) | Read access via signed request → see "Per-agent isolation" below. |

### Per-agent isolation

Memories are scoped per `agentId` and isolation is enforced **server-side** by Ed25519 signature verification — not by client convention. An attacker with another agent's key cannot read your agent's memories even on the same Flair instance. Cross-agent sharing requires an explicit grant.

This is a different threat model from password-based or API-key-based memory services where a leaked key gives access to the full namespace.

## See also

- [`docs/auth.md`](auth.md) — full auth scheme and signature format
- [`docs/mcp-clients.md`](mcp-clients.md) — wiring the flair-mcp server into Claude Code / Gemini CLI / Codex CLI
- [`packages/hermes-flair/README.md`](../packages/hermes-flair/README.md) — Hermes-specific plugin auth notes
