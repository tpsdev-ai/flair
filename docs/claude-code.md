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

## Continuity across compaction (`flair-precompact`, optional)

When Claude Code compacts a conversation, it replaces the history with a summary, and whatever the summary leaves out is gone from the agent's context: a rule the user gave an hour ago, the open task list, the work in flight. `flair-precompact` is a `PreCompact` hook that saves one bounded record just before that happens, and `flair-session-start` shows the record first when the session continues after the compaction, or when the next session starts after a restart.

It needs `flair-session-start` installed (`flair hook install`): that hook creates the per-session continuity state the record belongs to, and it is the one that shows the record. `flair hook install` does not write the PreCompact entry, so add it to `~/.claude/settings.json` by hand:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'out=$(FLAIR_AGENT_ID=my-project npx -y -p @tpsdev-ai/flair-mcp@<version> flair-precompact 2>/dev/null) && printf %s \"$out\" || true'",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Swap `my-project` for your agent ID and `<version>` for `flair --version`. With no `matcher`, the hook runs for both `/compact` (`manual`) and automatic (`auto`) compaction. A PreCompact hook that exits 2 blocks compaction; this command always exits 0 (the `|| true` covers a launcher that fails before the hook runs), and `timeout` bounds the launcher, whose start-up happens before the hook's own budget begins.

What the record holds, all of it copied from the end of the transcript (no model call, no summary):

- **Standing instructions**: sentences from your own turns that start with a rule-giving phrase (don't, do not, never, always, stop, avoid, make sure, remember to, from now on, going forward) or contain always, never, from now on, going forward or in (the) future. Questions are skipped. At most 6, the newest, 200 characters each.
- **Open tasks**: the task tools' list (`TaskCreate`/`TaskUpdate`, and `TodoWrite` when a session has it enabled), minus completed and deleted tasks. At most 8.
- **In-flight work**: the last 5 file edits and shell commands, recorded the way `flair-continuity-capture` records them: a file's path, a shell command's description, never the command itself.
- **The last assistant message**, cut to 300 characters.

A section with nothing in it is left out, and when nothing at all was found no record is written. The whole record is at most 2,000 characters. The hook reads at most the last 1 MiB and the last 2,000 lines of the transcript, and never reads tool results, thinking, subagent turns or messages the harness wrote (task notifications, slash commands and their output, system reminders, compaction summaries).

Before anything is stored, credential-shaped strings are replaced with `[redacted]`: private key blocks, `user:password@` in URLs, `Bearer` and `Basic` values, `name=value` and `name: value` pairs whose name contains password, secret, token, credential, or api, access or private key, and tokens with a known prefix (for example `sk-`, `ghp_`, `github_pat_`, `xox…-`, `AKIA`, `AIza`, `npm_`, JWTs). This is pattern matching and best effort: a secret with no recognizable shape, such as a bare password in a sentence, is stored as written. The record lives in the ephemeral tier (expires after 24 hours), is private to the agent, and is written with the agent's own key through the same signed request as the continuity journal; the hook never uses `FLAIR_ADMIN_USER` or `FLAIR_ADMIN_PASSWORD`.

One compaction gives one record. When the hook runs again for the same session and trigger within 5 minutes of the record's first write, it updates that record instead of adding a second one; the record's id is kept in `~/.flair/session/<agent>.precompact.json`, which holds ids and a timestamp, never record content. Two genuine compactions of the same kind within those 5 minutes therefore share one record, holding the newer state.

The hook never blocks compaction. Its time budget (`FLAIR_PRECOMPACT_TIMEOUT_MS`, default 5000 ms, 250 to 15000) covers the whole process from its start. When Flair is unreachable, slow or refuses the write, or the transcript or the hook's own files cannot be read, Claude Code shows one short warning naming the reason, and compaction goes ahead either way. After a timeout the warning says the record may be missing: Flair can still finish a write the hook stopped waiting for.

Limits worth knowing:

- The instruction heuristic is simple. It misses a rule phrased any other way ("I'd rather you ask first", other languages), and it can pick up a sentence that only mentions the words ("I never said that").
- Claude Code writes the transcript asynchronously, so the newest messages may not be in it yet when the hook runs.
- Only the end of the transcript is read: a task created before that part has no name there and is left out, and an instruction given before it is not seen.
- The transcript's format is Claude Code's own, not a documented interface; a field the hook does not recognize is skipped, never guessed.
- After a restart, the record shown is the one the previous session saved at its last compaction, which can be older than that session's final state. The block says when it was written; treat it as a signal to check, not an instruction.
- The marker file remembers only the newest record per agent ID. When two sessions share one agent ID and both compact, the session that compacted first no longer finds its record through the marker.

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
