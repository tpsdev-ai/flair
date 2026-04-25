# The team behind Flair

This is how LifestyleLab actually runs the multi-agent team that builds Flair, TPS, and the rest of our open-source stack. We dogfood every part of what we ship — the agents themselves are the reference implementation.

If you're trying to run your own multi-agent team using Flair as the memory layer, this is the most concrete example you'll find. Steal whatever's useful.

## Roster

| Agent | Role | Runtime | Model | Where it runs |
|---|---|---|---|---|
| **Flint** | Strategy, product, PR review | Claude Code | Claude Opus | rockit (Mac Mini) |
| **Anvil** | Implementation, PR opener | OpenClaw | Claude Sonnet (API) | exe.dev VM (`tps-anvil.exe.xyz`) |
| **Kern** | Architecture / perf review | OpenClaw | Open-source via Ollama | newton (Mac Studio) |
| **Sherlock** | Security review | OpenClaw | Open-source via Ollama (local-only) | newton (Mac Studio) |
| **Pulse** | EA / intel scanning / coordination | OpenClaw | Claude API | exe.dev VM (`pulse.exe.xyz`) |
| **Nathan** | Founder / product owner / human-in-the-loop | (human) | (human) | wherever |

Every agent has its own Ed25519 identity in Flair. They sign every memory write and every read. **Cross-agent reads are refused at the Flair API layer**, not by client convention — Sherlock can't accidentally read Pulse's memories even on a shared Flair instance, because the signature won't verify.

## How memory flows

```
                                ┌────────────────────────┐
                                │  Flair (rockit)        │
                                │  http://rockit:9926    │
                                │                        │
                                │  Per-agent isolation   │
                                │  enforced server-side  │
                                │  via Ed25519 signing   │
                                └─────────▲──────────────┘
                                          │
        ┌─────────────────┬───────────────┼──────────────┬─────────────────┐
        │                 │               │              │                 │
   Flint               Anvil           Kern          Sherlock           Pulse
  (rockit)        (tps-anvil)       (newton)         (newton)         (pulse.exe.xyz)
        │                 │               │              │                 │
   reads/writes      reads/writes    reads/writes   reads/writes      reads/writes
   own memories      own memories    own memories   own memories      own memories
        │                 │               │              │                 │
        └─────────────────┴────────┬──────┴──────────────┴─────────────────┘
                                   │
                            (no cross-agent reads
                             without explicit grant)
```

Each agent's memory is independent. When Flint commits a piece of strategy, only Flint sees it on `memory_search`. When Sherlock writes a security finding, only Sherlock sees it. **By design.** Memory leaks between agents are how multi-agent teams break — different roles need different perspectives, and a security reviewer that's been told all of marketing's speculative ideas is no longer a credible reviewer.

When agents need to *coordinate*, they don't share memory — they pass **explicit messages** through TPS mail (a separate signed delivery channel; see [tpsdev-ai/cli](https://github.com/tpsdev-ai/cli)). The handoff is intentional and traceable. Memory is private; messages are interpersonal.

## Why these splits

### Different runtimes for different work

- **Claude Code (Flint)** — strategic + code review needs Opus's depth, and Claude Code's tool ecosystem (Bash, Read/Edit/Write, web fetch, MCP) is the broadest available for "do real work in a real repo."
- **OpenClaw (Anvil, Kern, Sherlock, Pulse)** — for agents that don't need a full IDE-grade tool surface but DO need stable always-on background capability with model-fallback routing, OpenClaw is the right runtime. It's also the one we built into TPS, so we eat our own dog food.

This isn't a value judgment of one runtime over another — it's about matching the runtime to what the agent has to do. **The whole team uses Flair as the memory layer regardless of runtime.** That's the point: Flair is orchestrator-agnostic.

### Local vs API for inference

- **Anvil + Pulse on the Anthropic API** — high-throughput implementation work and EA-shaped intel scanning need frontier model quality and consistent latency. Worth the API spend.
- **Kern + Sherlock on local Ollama (`newton`)** — review work can be slower and is bursty (a few PRs/day). Self-hosted on a Mac Studio Ollama install means no rate limits, no session-locks, no third-party data exposure. Both currently run **gpt-oss:120b** as primary (OpenAI's open weights, Apache 2.0), with `nemotron-3-super:120b` and `deepseek-r1:70b` in the local fallback chain. **Sherlock is local-only as a deliberate privacy decision** — security findings are pre-disclosure-sensitive, not appropriate to send to any external inference provider.
- **Flint on Opus** — strategy + spec writing is rate-of-thought, not rate-of-tokens. Opus's reasoning depth matters more than throughput.

> **Note on the migration trial period (2026-04-25 → ~2026-05-02):** during the first week after K&S moved off Gemini, we kept Gemini as the *last* fallback in the chain to catch any quality regressions. After the trial period that fallback gets removed and K&S are strictly local. If you're copying this setup, decide upfront whether you want a cloud safety net during your own migration — and remove it on a known date.

### Different hardware for different load

- **rockit (Mac Mini)** — always-on, lightweight, runs Flint + the rhythm-agent watchdog + the local Flair Harper instance.
- **newton (Mac Studio M3 Ultra, 96GB)** — heavy local inference. Hosts Ollama + cloud-pass-through. Kern + Sherlock both target this box.
- **exe.dev VMs** — cloud agents that need internet-side work (pulse fetches news/intel; anvil opens GitHub PRs from a clean network space). Independent failure domain from the local stack.
- **(planned)** Jetson Orin Nano for the rhythm-agent dispatcher in v1, freeing rockit's CPU for Flint.

## The handoff loop

Standard PR-shaped work flows like this:

```
  1. Nathan brings a need to Flint (Discord)
  2. Flint writes a spec, files it in ~/ops/specs/, updates Beads
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
- **Bridges:** when an agent needs context from a foreign system (e.g., Anvil needs to import lessons from `agentic-stack/`), bridges import them into Flair without a custom integration per source.

The MCP server (`@tpsdev-ai/flair-mcp`) is what makes this orchestrator-agnostic — Flint's Claude Code, Anvil/Kern/Sherlock/Pulse's OpenClaw all hit the same Flair server with the same per-agent isolation guarantees.

## What we deliberately don't do

- **No shared "team memory."** Agents pass explicit messages via TPS mail. Memory is private by default. Sharing requires an intentional grant.
- **No silent LLM-driven memory extraction.** Each agent decides what it remembers. No background "summarize and persist" on every turn — that's how memory drifts away from intent.
- **No multiple agents on one identity.** "Anvil" and "Anvil-2" would be two separate agentIds with two separate keys. Same workload, different identities, isolated memories.
- **No replay-safe-but-otherwise-unsigned reads.** Every Flair request is Ed25519-signed and verified, including reads. Even on a private network we don't trust the network.
- **No password-based access to memory.** A leaked Flair admin password lets you read the database via Harper directly, but doesn't let you impersonate an agent — you can't write under their identity without their key. We treat that as the right asymmetric defense.

## What we're still figuring out

- **Cross-agent visibility for collaborative work.** Sometimes Flint needs Sherlock's recent security findings to write a spec. Today Flint asks via TPS mail; Sherlock answers. We're considering an explicit `flair memory share` mechanism with audit trails. Not in 1.0.
- **Rhythm agent v1.** Today's v0 is a shell-cron polling for state changes and posting to Discord. v1 lives on a Jetson, uses a small local model to summarize, and escalates only when truly stuck. Post-1.0 polish.
- **A `nathan-local` ops-EA on his laptop** that handles laptop-local tasks (files, browser, SSH-keyed ops) Pulse can't reach from the cloud. Identity model: acts AS Nathan, not as a peer agent. In design.

## Try this with your own team

Pick a starting point that matches your scale:

- **Solo, want continuity across sessions:** install Flair, give Claude Code an MCP-wired identity (see [`docs/mcp-clients.md`](mcp-clients.md)). One agent. Done.
- **Pair, want explicit handoffs without losing context:** add a second agent identity, each with their own MCP config + Flair agentId. Pass work via TPS mail or your own coordination channel.
- **Small team, want to see this rig work end-to-end:** clone our setup. Use our Beads issue tracker, our TPS mail, our agent role-splits. Replace Nathan with whoever's playing founder/product-owner.
- **Bigger team:** federate Flair instances (per [`docs/federation.md`](federation.md)). Each office has its own Flair, signed cross-instance memory sharing. Same per-agent isolation guarantees scale across nodes.

Read the rest of the docs from there.
