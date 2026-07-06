# Flair — Design Invariants

This is Flair's design DNA: the invariants that decide what code we write and, just as
importantly, what we refuse to build — not a feature list (see [README.md](README.md))
and not an API reference (see [docs/](docs)). If you're adopting Flair, extending it, or
wondering why it works a certain way, this is the page that answers "why," not "what."

## The three primitives

Flair is built on exactly three primitives: **identity**, **memory**, **soul**.

- **Identity** — an Ed25519 key pair per agent. Every request is signed; there are no
  passwords, no API keys, no shared secrets to leak. Identity is the root of everything
  else: it's what makes a memory *attributable* and what makes provenance possible at all.
- **Memory** — durable, semantically searchable knowledge, tiered by durability
  (`permanent` / `persistent` / `standard` / `ephemeral`), decay- and relevance-aware on
  retrieval. Memory is what turns a stateless completion into an agent that persists
  across restarts and harnesses.
- **Soul** — personality, values, procedures: the stuff that makes an agent *that agent*
  rather than an interchangeable instance of a model. Soul is kept distinct from memory
  on purpose — identity-defining context shouldn't compete with a firehose of daily
  observations for retrieval budget, and it shouldn't drift the way an unbounded memory
  store can.

These three and no more, because they map to the three things chat-history-as-memory
can't give an agent: proof of *who it is*, a durable record of *what it learned*, and a
stable sense of *what it's like*. Everything else in Flair (federation, REM, bootstrap,
bridges) is infrastructure in service of these three, not a fourth primitive.

## Overwhelm, not secrecy, is the enemy

The problem a memory system exists to solve is **too much noise**, not keeping teammates
out. An agent doesn't fail because a coworker could theoretically read its notes; it fails
because it's buried under thousands of low-value observations and can't find the one that
matters right now.

That reframes the whole design: the fix for "don't overwhelm the agent" is **relevance**
— bootstrap and search surface the scored, budgeted few — never access control. Using
`private` to solve a noise problem is a category error: it hides information from the
people who'd benefit from it in order to solve a problem (overwhelm) that access control
doesn't actually fix. Relevance ranking is the only correct lever for noise; access
control is reserved for a different problem entirely (below).

## Access model: open within the org, closed at the federation edge

> **Rollout note:** open-within-org read is the design and the direction Flair is
> converging on; the current release still gates cross-agent reads by explicit grant
> (see [SECURITY.md](SECURITY.md)) — the two converge when the within-org open-read
> change deploys (blocked on hardening the federation edge first; see below). This doc
> describes the model Flair is built toward, not a claim about today's default behavior.

Inside one Flair instance, every agent is inside the same trust boundary — that's what
"one org" means (a Flair deployment *is* an org: the set of agents sharing one instance).
There's nothing structural to hide a teammate's memory from another teammate on the same
instance, so the design target is **open read within the org**. The only hard access
boundary is the **org edge** — federation, sync between separate Flair instances — because
that's the only place two genuinely different trust boundaries meet.

`private` still exists, but as the rare, deliberate exception opted into for a real secret
(an EA's personal-principal context, a confidential project mid-flight) — not as the
default, and not as a scoping tool for "this is someone else's concern." Reaching for
`private` to keep noise down is the mistake described above; reaching for it to protect an
actual secret is exactly what it's for.

Opening within-org read is deliberately sequenced *after* the federation edge is hardened
— an org boundary that isn't actually enforced at the edge would make "open within org"
unsafe, since org-internal openness assumes the edge is the only place isolation is
needed. Hardening first, opening second, is not a delay tactic; it's the order the
invariant requires.

## Zero knobs — quality and trust are emergent

Memory quality and trust are never rated, tagged, or configured by an agent or an
operator. There is no "mark this memory as authoritative" knob, no trust-tier dial to
turn. Trust is **derived**, automatically, from:

- **Corroboration**, weighted by independence — agreement between sources that share a
  model or a source chain is one data point wearing many hats, not two; correlated
  agreement doesn't get to look like strong corroboration.
- **Supersession over time** — when a later, better-informed observation contradicts an
  earlier one, the later one supersedes it. The earlier one isn't deleted; "agent X
  believed M under conditions C, later corrected" is itself signal about how much to
  trust conditions C.
- **Outcomes** — the deepest signal isn't agreement, it's vindication: did the claim hold
  up over time.

REM (the refinement process that distills the raw pile into consolidated, corroborated
knowledge) is what makes an open, un-gated memory pile survivable — it's the mechanism
behind relevance-first bootstrap and search, not a fourth access-control layer.

**The minority can be right.** A correct minority view must be able to overturn a
corroborated majority — first discoveries, fresh information, and expert dissent all
depend on this. Contradiction is treated as a **flag, not a verdict**: conflicting
observations are held open with their provenance attached and surfaced, not silently
resolved by vote. A memory system that settles disagreement by headcount is an echo
chamber that calcifies error — worse than having no shared memory at all.

## Provenance is the anchor — trust is earned, not assigned

Every memory carries not just *who* wrote it but *under what conditions*. That provenance
splits into two tiers that the trust math treats very differently:

- **Verified** — the agent's Ed25519 identity and a signed timestamp. Cryptographically
  unforgeable; this is solid ground.
- **Claimed** — self-reported context like which model or skills were in play at write
  time. Useful signal, but forgeable — an agent can misreport what it used — so claimed
  provenance is *discounted* until corroborated. Systematic misreporting becomes
  detectable over time as claims fail to hold up against outcomes.

Provenance is never a gate ("only verified memories are readable") — it's an input to
trust math that runs continuously in the background. An unknown-provenance memory (e.g.
one written before provenance capture existed) is treated as low-prior, not untrusted.

## Additive, always

Every change to Flair's data model is additive. Existing data reads exactly as it did
before the change; nothing is silently reinterpreted, narrowed, or requires an operator to
run a migration to stay correct. New capability shows up as a new, nullable field or a new
table — never a breaking reshape of an old one. This is a design invariant, not a
convenience: it's what lets a self-hosted operator upgrade Flair without needing to trust
that they ran the right migration script first. Safety comes from how the change is built,
not from a runbook step someone might skip.
