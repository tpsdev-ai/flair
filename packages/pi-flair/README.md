# @tpsdev-ai/pi-flair

Pi extension for Flair memory access — persistent memory from within pi sessions.

## Design Decision

**Implementation Path: Native pi Extension (Option B)**

- **MCP clients are NOT first-class in pi** — pi's core has no MCP client support. MCP appears only as anthropic-specific beta features in the SDK (`BetaMCPToolUseBlock`, etc.), not as a generic extension mechanism.
- **Option A (wrap flair-mcp)** would require:
  - Waiting for pi to support MCP servers natively
  - Deprecating flair-mcp's stdio transport in favor of HTTP-only
  - Splitting maintenance between MCP and pi extensions
- **Option B (native extension)** wins because:
  - Direct HTTP calls via `@tpsdev-ai/flair-client` (zero extra dependencies)
  - Full control over tool registration and session lifecycle hooks
  - Parity with flair-mcp features (search, store, bootstrap)
  - Works today — no pi roadmap dependency

Reference: [pi extensions docs](https://pi.dev/docs/extensions.md)

## Quick Start

### Prerequisites

```bash
npm install -g @tpsdev-ai/flair
flair init
flair agent add my-agent
```

### Install

```bash
pi install npm:@tpsdev-ai/pi-flair
```

Or project-local:

```bash
pi install -l npm:@tpsdev-ai/pi-flair
```

### Configure

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "extensions": ["npm:@tpsdev-ai/pi-flair"],
  "packages": ["npm:@tpsdev-ai/pi-flair"]
}
```

Or use environment variables:

```bash
export FLAIR_AGENT_ID=my-agent
export FLAIR_URL=http://127.0.0.1:9926
pi
```

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories by meaning. Understands temporal queries. |
| `memory_store` | Save memories with type + durability (permanent/persistent/standard/ephemeral). |
| `bootstrap` | Load session context: soul + memories + predicted context. |

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `FLAIR_AGENT_ID` | *(required)* | Agent identity for memory scoping |
| `FLAIR_URL` | `http://127.0.0.1:9926` | Flair server URL |
| `FLAIR_KEY_PATH` | auto-resolved | Path to Ed25519 private key |
| `FLAIR_MAX_RECALL_RESULTS` | `5` | Max results for memory_search |
| `FLAIR_MAX_BOOTSTRAP_TOKENS` | `4000` | Max tokens in bootstrap output |
| `FLAIR_AUTO_RECALL` | `false` | Auto-load bootstrap on session start (opt-in) |
| `FLAIR_AUTO_CAPTURE` | `false` | Auto-save session context to memory |

## Security Notes

### Auto-Capture Warning

When `FLAIR_AUTO_CAPTURE=true`, all assistant responses are persisted to Flair memory with **ephemeral durability**. **This includes any secrets, credentials, or tokens your LLM may output.**

**Do not enable `FLAIR_AUTO_CAPTURE=true` if your sessions may output:**

- API keys (`sk-`, `ghp_`, `pat_`, etc.)
- Bearer tokens (`Bearer ` prefix)
- Private keys (`-----BEGIN PRIVATE KEY-----`, `-----BEGIN RSA PRIVATE KEY-----`)
- AWS/GCP/Azure credentials
- Any other sensitive data

Auto-capture is best-effort and uses `dedup: false` to ensure all content is captured. For production use, disable auto-capture and store only non-sensitive summaries manually via `memory_store`.

## How It Works

```
pi (extension) ↔ HTTP ↔ Flair (Harper)
```

The extension calls Flair's HTTP API directly via `@tpsdev-ai/flair-client`. All memory is stored locally in `~/.flair/` with Ed25519 authentication.

## Examples

### Semantic Search

```ts
// In a pi session:
memory_search(query: "what did I decide about auth flow?", limit: 5)
```

### Store Memory

```ts
memory_store(
  content: "PR reviews must include security assessment",
  durability: "persistent"
)
```

### Bootstrap

```ts
bootstrap(maxTokens: 4000)
```

## Testing

```bash
cd packages/pi-flair
npm run build
# Run tests (TBD)
```

## License

[Apache 2.0](../../LICENSE)
