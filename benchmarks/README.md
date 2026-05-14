# Flair benchmarks

Public, reproducible measurement of agent task performance **with vs without Flair memory**. Lets operators see ROI, lets us back up the "memory makes agents better" claim with numbers instead of vibes.

## Status

**Scaffold.** Task definitions + harness shape live here; baseline numbers haven't been collected yet. Reproducibility methodology is the priority — anyone should be able to clone, run, and compare against our published results.

## Methodology

Each benchmark **task** is a scripted scenario — a sequence of agent turns testing a specific capability that memory should improve. Tasks are deliberately small and representative; the goal is reproducibility, not perfect coverage.

For each task, we run two **variants**:

| Variant | Description |
|---|---|
| `baseline` | Agent has no persistent memory between sessions. Each session starts cold. |
| `flair` | Agent uses Flair as its memory backend. Bootstrap loads relevant memories on session start; `memory_store` writes new ones during the session. |

Each variant is run **N times** (default N=5) per task to reduce model noise. Results are scored on three axes:

- **Accuracy** — does the response satisfy the task's success criteria? Scored via LLM-as-judge (Claude Opus 4.7, blind to variant).
- **Tokens** — input + output tokens consumed. Captured directly from API responses.
- **Time** — wall-clock seconds from prompt sent to final response received.

A fourth axis (**hallucination rate**) is tallied separately — the LLM-judge flags responses that fabricate facts unsupported by either the task context or remembered facts.

## Tasks (planned)

| ID | Title | Capability tested |
|---|---|---|
| 01 | Decision recall | Agent recalls a prior decision and its rationale across sessions |
| 02 | Fact lookup vs hallucination | Agent retrieves a user-stated fact vs. confabulates |
| 03 | Reference resolution | Agent resolves "the bug we found yesterday" without re-asking |
| 04 | Cross-session continuity | Multi-turn task spanning two distinct sessions |
| 05 | Cross-orchestrator continuity | Same agent identity, different MCP clients, state continuity |

Each task lives at `tasks/<id>-<slug>.ts` with a `Task` export. See `harness/types.ts` for the contract.

## Why these tasks

Memory's value is hardest to measure on single-turn tasks because the model has no chance to forget anything. We deliberately design **multi-turn / multi-session** scenarios where the absence of memory shows up as failure or token-waste.

We do NOT include:

- Code generation benchmarks (SWE-bench, HumanEval) — those don't isolate the memory dimension.
- General reasoning (MMLU, ARC) — same reason; model capability dominates the signal.
- Synthetic memorization tests (e.g., "remember this random string") — these test recall capacity, not the agent's ability to USE memory productively.

## Running benchmarks (when ready)

```bash
cd benchmarks
npm install
npm run bench -- --task 01-decision-recall --variant flair --runs 5
npm run bench -- --task 01-decision-recall --variant baseline --runs 5
npm run report -- --task 01-decision-recall
```

Results land in `results/<run-id>/` as JSON; the report command renders a markdown summary.

## Reproducibility

Each run records:

- Task definition hash (so we know which version was tested)
- Model + temperature + system prompt
- Flair instance version (if applicable)
- Full turn-by-turn transcript
- Token + time measurements

External operators can re-run against their own Flair instance + their own API credentials. The judge model is configurable.

## What this is NOT

This is not a leaderboard. We're not racing Mem0 or Letta in benchmark numbers — different products, different shapes. The honest framing is:

> *"With Flair memory, agents complete these multi-session tasks 2.3x faster on average and hallucinate 47% less often. Here's the methodology, here are the transcripts. Run it yourself."*

A bigger goal is exposing a methodology that any memory-product team can run on their stack — comparable apples-to-apples results across the space. We're publishing first because we want the methodology to be the standard.

## Open work

- [ ] Task 01 scaffold: agent harness + transcript capture
- [ ] LLM-as-judge prompt + scoring rubric
- [ ] Baseline variant (no Flair) — uses simple system prompt only
- [ ] Flair variant — bootstrap + memory_store wired in
- [ ] CLI runner with `--runs`, `--variant`, `--task` flags
- [ ] Report renderer (markdown + summary stats)
- [ ] Reproducibility guide for external runs
- [ ] First public results — at least 3 tasks × 2 variants × 5 runs
