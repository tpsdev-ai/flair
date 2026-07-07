# The team behind Flair

This is how LifestyleLab actually runs the multi-agent team that builds Flair, TPS, and the rest of our open-source stack. We dogfood every part of what we ship — the agents themselves are the reference implementation.

If you're trying to run your own multi-agent team using Flair as the memory layer, this is the most concrete example you'll find. Steal whatever's useful.

## Roster

| Agent | Role | Runtime | Model | Where it runs |
|---|---|---|---|---|
| **Flint** | Strategy, product, PR review | Claude Code | Claude Opus | always-on local host |
| **Anvil** | Implementation, PR opener | OpenClaw | Claude Sonnet (API) | cloud VM |
| **Kern** | Architecture / perf review | OpenClaw | Open-source via Ollama | local inference box |
| **Sherlock** | Security review | OpenClaw | Open-source via Ollama (local-only) | local inference box |
| **Pulse** | EA / intel scanning / coordination | OpenClaw | Claude API | cloud VM |
| **Nathan** | Founder / product owner / human-in-the-loop | (human) | (human) | wherever |

Every agent has its own Ed25519 identity in Flair. They sign every memory write and every read. **Writes are isolated at the Flair API layer** — Sherlock can't accidentally (or maliciously) write into Pulse's memory, because the signature won't verify for anyone but Pulse. Reads are a different story: within one Flair instance, any verified agent can read any other agent's **non-private** memory — that's the shipped model (open-within-org read, no grant needed), not a gap. An agent keeps something genuinely sensitive owner-only by writing it with `visibility: private`. The hard access boundary is the **federation edge** (a separate Flair instance), not reads within one.

## How memory flows

```
                                ┌────────────────────────┐                  
                                │  Flair (self-hosted)   │                  
                                │                        │                  
                                │  Write isolation +     │                  
                                │  open-within-org read, │                  
                                │  enforced server-side  │                  
                                │  via Ed25519 signing   │                  
                                └─────────▲──────────────┘                  
                                          │                                 
        ┌─────────────────┬───────────────┼──────────────┬─────────────────┐
        │                 │               │              │                 │
   Flint               Anvil           Kern          Sherlock           Pulse
   (local)           (cloud VM)    (inference box) (inference box)    (cloud VM)
        │                 │               │              │                 │
   writes own          writes own      writes own     writes own       writes own
   memories only        memories only   memories only  memories only   memories only
        │                 │               │              │                 │
        └─────────────────┴────────┬──────┴──────────────┴─────────────────┘
                                   │
                       (every agent can read every other
                        agent's non-private memories —
                        `visibility: private` stays owner-only)
```

No agent can write into another agent's memory — that's enforced server-side by signature verification, no exceptions. Reads are intentionally open within the org: when Flint commits a piece of strategy, any agent can find it on `memory_search` unless Flint marked it `private`. **By design** — the goal is relevance and findability across the team, not secrecy between roles. An agent that genuinely needs something to stay owner-only (a draft not ready for the team, a sensitive finding pre-disclosure) marks it `visibility: private`; everything else is fair game for any teammate to search.

When agents need to *coordinate* — a direct, targeted handoff rather than ambient searchable memory — they pass **explicit messages** through TPS mail (a separate signed delivery channel; see [tpsdev-ai/cli](https://github.com/tpsdev-ai/cli)). That's a different concern from memory visibility: TPS mail is for "I need you, specifically, to see this now"; Flair memory is the shared, searchable record everyone (except where `private`) can draw on later.

## Why these splits

### Different runtimes for different work

- **Claude Code (Flint)** — strategic + code review needs Opus's depth, and Claude Code's tool ecosystem (Bash, Read/Edit/Write, web fetch, MCP) is the broadest available for "do real work in a real repo."
- **OpenClaw (Anvil, Kern, Sherlock, Pulse)** — for agents that don't need a full IDE-grade tool surface but DO need stable always-on background capability with model-fallback routing, OpenClaw is the right runtime. It's also the one we built into TPS, so we eat our own dog food.

This isn't a value judgment of one runtime over another — it's about matching the runtime to what the agent has to do. **The whole team uses Flair as the memory layer regardless of runtime.** That's the point: Flair is orchestrator-agnostic.

### Local vs API for inference

- **Anvil + Pulse on the Anthropic API** — high-throughput implementation work and EA-shaped intel scanning need frontier model quality and consistent latency. Worth the API spend.
- **Kern + Sherlock on local Ollama** — review work can be slower and is bursty (a few PRs/day). Self-hosting on a local Ollama box means no rate limits, no session-locks, no third-party data exposure. Both run a large open-weight model (~120B class, permissively licensed) as primary, with smaller open models in the local fallback chain. **Sherlock is local-only as a deliberate privacy decision** — security findings are pre-disclosure-sensitive, not appropriate to send to any external inference provider.
- **Flint on Opus** — strategy + spec writing is rate-of-thought, not rate-of-tokens. Opus's reasoning depth matters more than throughput.

> **Note on migration safety nets:** when we moved the review agents off a previous cloud model onto local inference, we kept the old model as the *last* fallback for a short trial window to catch quality regressions, then removed it on a fixed date. If you're copying this setup, decide upfront whether you want a cloud safety net during your own migration — and remove it on a known date.

### Different hardware for different load

- **Always-on local host** — lightweight, runs the founder-facing agent + a watchdog + the local Flair Harper instance.
- **Local inference box** — heavier local inference on a workstation with strong unified memory / GPU. Hosts Ollama; the review agents target this box.
- **Cloud VMs** — agents that need internet-side work (intel fetching, opening GitHub PRs from a clean network space). Independent failure domain from the local stack.

## The handoff loop

Standard PR-shaped work flows like this:

```
  1. Nathan brings a need to Flint (Discord)
  2. Flint writes a spec, files it in the planning repo, updates Beads
  3. Flint mails Kern + Sherlock for arch + security review of the SPEC
     (catch issues at design time, not after implementation)
  4. K&S respond with concerns or sign-off
  5. Flint refines spec, hands off to Anvil:
        @Anvil <spec-path> branch:<name>. Open PR to main when done.
  6. Anvil works on a feature branch, opens PR
  7. Flint reviews PR, requests K&S review on the implementation
  8. K&S review, comment, approve
  9. CI green + 1 approval (or 2 for security-surface PRs) → merge
 10. Pulse's intel cron picks up the merge in the next 24h cycle and
     adds it to the team's situational awareness
```

The rule that keeps this honest: **K&S approvals are individually load-bearing.** A "yes I approve" with a templated body that doesn't engage with the actual code is rejected — they have to write their own one-line rationale based on what they actually found. Otherwise the gate is theatrics. (This was a real lesson; we learned it the hard way after a rubber-stamp made it into the audit log.)

## How Flair fits in

Flair is the connective tissue:

- **Identity:** every agent has an Ed25519 keypair in Flair (`flair agent add <id>`). All signed requests, no shared passwords, no env-var secrets to leak.
- **Memory:** each agent writes its own lessons, decisions, observations. Flint's strategic memory survives a session crash. Anvil's "this codebase pattern works for X but fails for Y" persists across PR iterations.
- **Soul:** each agent has a permanent personality block — role, voice, constraints. Loaded on every bootstrap so the agent stays *themselves* across sessions.
- **Bridges:** when an agent needs context from a foreign system (e.g., Anvil needs to import lessons from another repo), bridges import them into Flair without a custom integration per source.

The MCP server (`@tpsdev-ai/flair-mcp`) is what makes this orchestrator-agnostic — Flint's Claude Code, Anvil/Kern/Sherlock/Pulse's OpenClaw all hit the same Flair server with the same write-isolation-plus-open-read guarantees.

## What we deliberately don't do

- **No shared write identity.** Every memory is written and owned by exactly one agent's Ed25519 key — there's no merged "team" identity that can write on another agent's behalf. Reads are a separate story: within the org, any agent can search any other's non-private memory by default (see [SECURITY.md](../SECURITY.md)) — that's intentional, not a leak. TPS mail is still how agents route a message to a *specific* teammate; it's for targeted delivery, not for gating ambient visibility.
- **No silent LLM-driven memory extraction.** Each agent decides what it remembers. No background "summarize and persist" on every turn — that's how memory drifts away from intent.
- **No multiple agents on one identity.** "Anvil" and "Anvil-2" would be two separate agentIds with two separate keys. Same workload, different identities, separately-owned memories.
- **No replay-safe-but-otherwise-unsigned reads.** Every Flair request is Ed25519-signed and verified, including reads. Even on a private network we don't trust the network.
- **No password-based access to memory.** A leaked Flair admin password lets you read the database via Harper directly, but doesn't let you impersonate an agent — you can't write under their identity without their key. We treat that as the right asymmetric defense.

## What we're still figuring out

- **Trust-weighting the open read pool.** Open-within-org read (#578, shipped in 0.21.0) means Flint no longer has to round-trip TPS mail to see Sherlock's recent security findings — `memory_search` already surfaces them directly. What's still unbuilt is any consolidation or trust-discounting of that shared pool: today it's a bigger unfiltered pile, not a ranked or corroborated one. That's the next arc (org-identity, emergent trust from provenance/corroboration/supersession) — it needs a founder-engaged design pass before we build it, not a solo build.
- **Rhythm agent v1.** Today's v0 is a shell-cron polling for state changes and posting to Discord. v1 moves to a dedicated low-power device, uses a small local model to summarize, and escalates only when truly stuck. Post-1.0 polish.

## Try this with your own team

Pick a starting point that matches your scale:

- **Solo, want continuity across sessions:** install Flair, give Claude Code an MCP-wired identity (see [`docs/mcp-clients.md`](mcp-clients.md)). One agent. Done.
- **Pair, want explicit handoffs without losing context:** add a second agent identity, each with their own MCP config + Flair agentId. Pass work via TPS mail or your own coordination channel.
- **Small team, want to see this rig work end-to-end:** clone our setup. Use our Beads issue tracker, our TPS mail, our agent role-splits. Replace Nathan with whoever's playing founder/product-owner.
- **Bigger team:** federate Flair instances (per [`docs/federation.md`](federation.md)). Each office has its own Flair — that org boundary (the federation edge) is what stays hard across nodes; reads are already open within each office's own instance.

Read the rest of the docs from there.
