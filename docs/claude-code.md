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

        flair bootstrap --agent my-project --max-tokens 4000

    Read the output — that's your soul and recent memories.

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
    - ephemeral — auto-expires after 72h. Use for temporary notes.

> **End of CLAUDE.md snippet.**

---

That's it. Claude Code will now bootstrap context on start and store important things as it works.

## Multiple Projects

Create a separate agent per project:

```bash
flair agent add project-alpha
flair agent add project-beta
flair agent add infra-ops
```

Each project's `CLAUDE.md` uses its own agent ID. Memories are fully isolated between projects.

## Subagents

Claude Code subagents (spawned via `/run` or background tasks) can share the parent's memory:

    ### Subagents
    Subagents share memory with the parent session. Use the same agent ID:
    FLAIR_AGENT_ID=my-project

    When spawning subagents, pass the agent ID so they can access shared context.

Or give subagents their own identity for isolation:

```bash
flair agent add my-project-review   # code review subagent
flair agent add my-project-test     # test runner subagent
```

## Environment Variables

Instead of passing `--agent` every time, set environment variables:

```bash
# In your shell profile or .envrc
export FLAIR_AGENT_ID=my-project
export FLAIR_URL=http://localhost:9926  # default, only needed if custom
```

Then the CLAUDE.md simplifies to:

    ## Memory
    - Bootstrap: `flair bootstrap`
    - Remember: `flair memory add --content "what you learned"`
    - Search: `flair search "your query"`

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

Soul entries are included in every `flair bootstrap` — they're the persistent context that shapes how Claude Code thinks about your project.

## Remote Flair

If you want to share memory across machines (e.g., work laptop + home setup):

```bash
# On your server
npm install -g @tpsdev-ai/flair
flair init
flair agent add my-project

# On client machines
npm install -g @tpsdev-ai/flair  # for the CLI
export FLAIR_URL=http://your-server:9926
export FLAIR_AGENT_ID=my-project
# Copy the key from the server:
scp server:~/.flair/keys/my-project.key ~/.flair/keys/
```

Or use an SSH tunnel:

```bash
ssh -f -N -L 9926:localhost:9926 your-server
# Now FLAIR_URL=http://localhost:9926 works
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
- **Dedup is automatic.** Writing the same fact twice won't create duplicates (0.7 similarity threshold).
