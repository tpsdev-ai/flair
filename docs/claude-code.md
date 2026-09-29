# Flair + Claude Code

Give Claude Code persistent memory across sessions. Works with subagents too.

## Setup (5 minutes)

### 1. Install Flair

```bash
npm install -g @tpsdev-ai/flair
```

### 2. Initialize

```bash
flair init
```

This starts a local Flair server (Harper) and creates `~/.flair/`.

### 3. Create an agent identity

```bash
# One agent per project, or one shared agent — your call
flair agent add my-project
```

This generates an Ed25519 key pair at `~/.flair/keys/my-project.key` and registers the agent with Flair.

### 4. Add to your project's CLAUDE.md

Copy this into your project's `CLAUDE.md` (or `.claude/settings.md`, `AGENTS.md`, etc.):

---

> **Start of CLAUDE.md snippet** — copy everything between the lines.

    ## Memory

    You have persistent memory via Flair. Use it to remember context across sessions.

    ### On session start

    Run this FIRST, before doing anything else:

        mcp__flair__bootstrap

    (`mcp__flair__bootstrap` is Claude Code's namespaced name for the server's `bootstrap` tool.)
    Read the output — that's your soul and recent memories.

    Use the CLI variant when MCP is not wired — previewing context yourself, a script, or any agent that can run a shell command:

        flair bootstrap --agent my-project --max-tokens 4000

    ### During work

    - Remember something: `flair memory add --agent my-project --content "what you learned"`
    - Search memory: `flair search "your query" --agent my-project`
    - Store a lesson: `flair memory add --agent my-project --content "lesson text" --type lesson --durability persistent`
    - Store a decision: `flair memory add --agent my-project --content "decision text" --type decision --durability persistent`

    ### What to remember

    - Lessons learned (bugs, workarounds, patterns)
    - Decisions made (why we chose X over Y)
    - Project-specific context (architecture, conventions, constraints)
    - User preferences (coding style, review standards)

    ### What NOT to remember

    - Transient task details (what file am I editing right now)
    - Things already in the codebase (read the code instead)
    - Secrets or credentials (never store these in memory)

    ### Durability levels

    - persistent — survives indefinitely. Use for lessons, decisions, preferences.
    - standard — default. Good for session context, observations.
    - ephemeral — auto-expires after 24h. Use for temporary notes.

> **End of CLAUDE.md snippet.**

---

This is a prompt-driven CLI setup: Claude must choose to run these commands. For MCP tools and automatic startup recall, run `flair init --agent my-project --client claude-code`, restart Claude Code, and verify the hook with `flair hook status --harness claude-code`; these prompt instructions do not guarantee automatic capture.

## Hooks

`@tpsdev-ai/flair-mcp` ships three Claude Code hooks. Each is a separate binary, each is optional, and each exits 0 on every failure, so none of them can block a session or a prompt.

| Hook | Claude Code event | What it does | Install |
|---|---|---|---|
| `flair-session-start` | `SessionStart` | Loads bootstrap context (soul plus relevant memories) when a session opens. | `flair hook install` ([details](mcp-clients.md#auto-recall-on-session-start-optional-hook)) |
| `flair-continuity-capture` | `PostToolUse` and `Stop` | Journals the agent's working state into the ephemeral memory tier, so the next session start can point at it with a one-line resume hint. | `flair hook install --continuity` |
| `flair-prompt-recall` | `UserPromptSubmit` | Searches memory with each prompt and adds the relevant memories as context before the model answers. | By hand, below |

### Per-prompt recall (`flair-prompt-recall`)

Session-start recall runs once. Later in the session a prompt can bring up something the agent's memory already covers, such as a user's direction on a named technique or an earlier decision, and unless something searches at that moment the agent answers without it. `flair-prompt-recall` searches on every prompt:

1. It builds a search query from the prompt, with markup, URLs and noise such as long ids stripped, bounded to 500 characters.
2. It runs the same hybrid search as the MCP `memory_search` tool, signed with the agent's own Ed25519 key, so the results are limited to what that agent may read.
3. It adds the hits whose score meets a relevance threshold (at most 4 by default), each with its id, date, score and a snippet, under a header that frames them as a signal, not an instruction, and tells the model to read the full memory before acting on it. The whole block is at most 2,000 characters. A memory that Flair's content scan flagged as possible prompt injection is shown with a fixed warning line ahead of its quoted text; cutting the text to fit never cuts the warning, so such a memory appears with its whole warning or not at all.

It never holds up a prompt. It skips prompts that are not questions: background task notifications, and acknowledgements too short to search ("ok, thanks"). It exits 0 on every path. When Flair is unreachable, slow or refuses the request, it adds no memories, only one line saying recall was unavailable for that prompt.

The time budget (3 seconds by default) runs from the moment the hook process starts: reading the prompt, reading the config file and the search all count against it. When it runs out during asynchronous work (waiting for the prompt on stdin, reading the config file, connecting to Flair or downloading its response), the hook prints the one "unavailable" line and exits 0 at once. The prompt payload is read up to 1 MiB (a larger one is not searched), and the config file is read only if it is a regular file of at most 256 KiB. Once a response has arrived in full, the Flair client parses it and converts every result in it before returning, synchronously; the deadline cannot interrupt that work, and there is no cap on the size of a response that arrives within the budget. After the client returns, the hook's own processing looks at no more than the requested number of results and the first 4,096 characters of each memory. What happens before the process starts is outside the budget: the launcher and node's own start-up.

`flair hook install` does not write this hook, so wire it by hand. The hook runs on every prompt, so its launcher's start-up is added to every turn. Install the pinned package once into a directory of its own, and point the hook at its binary:

```bash
npm install --prefix ~/.flair-hooks @tpsdev-ai/flair-mcp@<version>
```

Then add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'out=$(FLAIR_AGENT_ID=my-project \"$HOME/.flair-hooks/node_modules/.bin/flair-prompt-recall\" 2>/dev/null) && printf %s \"$out\" || true'"
          }
        ]
      }
    ]
  }
}
```

Swap `my-project` for your agent ID and `<version>` for `flair --version`. The binary runs with the `node` found on the hook's `PATH`, which must be Node 22 or later. The `sh -c ... || true` wrapper is the same one the SessionStart hook uses: if the command cannot run at all, the prompt goes through with no output. Nothing in the CLI rewrites this entry or that directory, so re-run the `npm install` with the new version after an upgrade.

The same `npx -y -p @tpsdev-ai/flair-mcp@<version> flair-prompt-recall` invocation the SessionStart hook uses also works in place of the binary path, at a cost: npx resolves the package before the hook process starts, on every prompt, outside the hook's budget. That adds npm's own start-up to every turn even when the package is cached, and a download when the pinned version is not in npx's cache.

| Setting | Environment variable | `~/.flair/config.yaml` key | Default |
|---|---|---|---|
| Relevance threshold, 0 to 1, on the search's absolute score | `FLAIR_PROMPT_RECALL_MIN_SCORE` | `promptRecallMinScore` | `0.62` |
| Most memories added per prompt, 1 to 10 | `FLAIR_PROMPT_RECALL_MAX_HITS` | `promptRecallMaxHits` | `4` |
| Time budget in milliseconds, from the hook's start, 250 to 15000 | `FLAIR_PROMPT_RECALL_TIMEOUT_MS` | `promptRecallTimeoutMs` | `3000` |

The environment wins over the config file, where the keys are top-level entries; a value that is missing or out of range falls through to the next source. Until the config file has been read, the hook's deadline uses the environment's budget or the default; a budget set in the config file applies from then on, still measured from the start. The hook reads `FLAIR_AGENT_ID`, `FLAIR_URL` and `FLAIR_KEY_PATH` like the other hooks. It never uses `FLAIR_ADMIN_USER` or `FLAIR_ADMIN_PASSWORD`: without an agent key the request goes out unsigned, Flair refuses it, and the prompt gets the one "unavailable" line.

## Multiple Projects

Create a separate agent per project:

```bash
flair agent add project-alpha
flair agent add project-beta
flair agent add infra-ops
```

Each project's `CLAUDE.md` uses its own agent ID. Writes carry an `agentId` field (tags are optional); reads use owner plus visibility.

## Subagents

Claude Code subagents (spawned via `/run` or background tasks) can share the parent's memory:

    ### Subagents
    Subagents share memory with the parent session when they use the same agent ID (to share, set `FLAIR_AGENT_ID=my-project`). A subagent with its own agent ID owns what it writes, but this is not isolation: only its private records are hidden from other agents, and it can still read other agents' non-private records. Writes without an explicit visibility default by durability: persistent and permanent are shared, standard and ephemeral are private.

    When spawning subagents, pass the agent ID so they can access shared context.

Or give subagents their own identity, so each owns what it writes (ownership, not isolation):

```bash
flair agent add my-project-review   # code review subagent
flair agent add my-project-test     # test runner subagent
```

## Environment Variables

Instead of passing `--agent` every time, set environment variables:

```bash
# In your shell profile or .envrc
export FLAIR_AGENT_ID=my-project
export FLAIR_URL=http://localhost:19926  # default, only needed if custom
```

Then the CLAUDE.md simplifies to:

    ## Memory
    - Bootstrap: `mcp__flair__bootstrap`
    - Remember: `flair memory add --content "what you learned"`
    - Search: `flair search "your query"`

    Use `flair bootstrap` when MCP is not wired.

## Soul (Personality / Context)

Want Claude Code to have consistent personality or project context? Set soul entries:

```bash
# Project context
flair soul set --agent my-project --key project \
  --value "E-commerce platform. Rust backend, React frontend. Ship quality over speed."

# Coding standards
flair soul set --agent my-project --key standards \
  --value "Always write tests. Prefer composition over inheritance. No any types in TypeScript."

# Review guidelines
flair soul set --agent my-project --key review \
  --value "Check for: error handling, edge cases, performance implications, security."
```

Soul entries are included in every bootstrap — they're the persistent context that shapes how Claude Code thinks about your project.

## Remote Flair

If you want to share memory across machines (e.g., work laptop + home setup):

```bash
# On your server
npm install -g @tpsdev-ai/flair
flair init
flair agent add my-project

# On client machines
npm install -g @tpsdev-ai/flair  # for the CLI
export FLAIR_URL=http://your-server:19926
export FLAIR_AGENT_ID=my-project
# Copy the key from the server:
scp server:~/.flair/keys/my-project.key ~/.flair/keys/
```

Or use an SSH tunnel:

```bash
ssh -f -N -L 19926:localhost:19926 your-server
# Now FLAIR_URL=http://localhost:19926 works
```

## Programmatic Access

For custom tooling, use the lightweight client library:

```bash
npm install @tpsdev-ai/flair-client
```

```typescript
import { FlairClient } from '@tpsdev-ai/flair-client'

const flair = new FlairClient({ agentId: 'my-project' })

await flair.memory.write('learned that X causes Y', {
  type: 'lesson',
  durability: 'persistent',
})

const results = await flair.memory.search('what causes Y')
const context = await flair.bootstrap({ maxTokens: 4000 })
```

## Tips

- **Bootstrap is cheap.** Run it at the start of every session. It's one HTTP call.
- **Write lessons immediately.** Don't wait for the session to end — you might not get the chance.
- **Use durability wisely.** Most things are `standard`. Only promote to `persistent` for things that should survive months.
- **Search is semantic.** "deployment issues" finds memories about "CI pipeline failures" — you don't need exact keywords.
- **Temporal queries work.** "What happened today" and "what did we ship recently" are understood.
- **Dedup is a report, not a write guard.** A successful create is stored even when it matches an earlier memory. For eligible creates, the server checks the top active candidate from the same agent using writer-overridable cosine and Jaccard thresholds, and returns `deduplicated` and `matchedId` on a match.
