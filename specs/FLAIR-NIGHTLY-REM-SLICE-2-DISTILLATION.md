# FLAIR-NIGHTLY-REM — Slice 2: In-Process Distillation

> REM executes reflection itself instead of handing back a prompt. Parent spec: `FLAIR-NIGHTLY-REM.md`. Tracking issue: #707.

**Status:** Design for review
**Owner:** Flint
**Depends on:** Harper `scope.models` (`models.generate()`; flair is on `@harperfast/harper` 5.1.17, generative network backends shipped in 5.1.x)

---

## § 1 Problem

`/ReflectMemories` returns `{ memories, prompt }` and expects "the agent" to run the prompt through its own LLM and write insights back. In practice nobody does: a user who runs reflection gets homework — a prompt to paste into an AI chat. The nightly runner (`src/rem/runner.ts`) ships steps 1–3 + 6 of the parent spec's § 4 cycle and explicitly parks steps 4–5 pending "an in-process distillation LLM path."

Everything around the LLM call already exists: scheduler, pre-run snapshots, restore, the `MemoryCandidate` table, `flair rem candidates/promote/reject`, audit-row fields. The engine has no motor. This slice adds the motor and nothing else.

## § 2 Approach — consume Harper's model-access API

Distillation executes **server-side in the Flair component** via `models.generate()`:

- **Zero provider code in flair.** Backend choice (local Ollama, OpenAI, Anthropic, Bedrock) is Harper `models:` configuration. Local Ollama needs no credentials; hosted providers take an API key.
- **Secrets:** on Fabric / managed deploys, provider keys ride Harper env-secret encryption (`enc:v1:` values — encrypted at rest, never plaintext in ops API/logs/replication). Self-hosted default needs no key at all.
- **Structured output:** request `responseFormat: { schema }` so candidates come back as validated JSON, not parsed prose. (Build-time check: confirm schema-mode support in the pinned Harper version for the configured backend; fallback is `responseFormat: 'json'` + strict parse with one retry, then fail closed — stage nothing.)

## § 3 Changes

### A. `/ReflectMemories` execute mode

New request field `execute?: boolean` (default `false` — existing prompt-return behavior unchanged).

When `execute: true`:
1. Gather memories + build the prompt exactly as today (same scope/focus/caps, same auth: `allowVerified`, non-admin actors reflect only on their own memories).
2. `models.generate(prompt, { model: <configured>, responseFormat: { schema: CANDIDATES_SCHEMA }, maxTokens, temperature })`.
3. Validate the result:
   - shape-validate against `CANDIDATES_SCHEMA`;
   - every `sourceMemoryIds` entry must be ⊆ the gathered memory set (reject any candidate citing memories outside the reflection input);
   - cap candidate count and claim length.
4. Persist each candidate as a `MemoryCandidate` row: `status=pending`, `generatedBy` = resolved model id, `generatedAt`, `sourceMemoryIds`, `rationalePrompt` = the prompt used. Skip claims that exactly duplicate an existing pending candidate for the agent.
5. Respond `{ candidates, count, model }` (no prompt, no embeddings).

All-or-nothing staging: validate the full candidate set before the first insert. A model failure or validation failure stages zero rows.

No configured/reachable generative backend → 503 with an actionable error (how to add a `models:` block; local Ollama recipe). Prompt mode is unaffected.

```
CANDIDATES_SCHEMA = {
  candidates: [ { claim: string, sourceMemoryIds: string[], tags?: string[] } ]
}
```

### B. Nightly runner step 5

Runner calls `/ReflectMemories` with `execute: true` after maintenance. Audit row gains `slice: "2"` with `candidates` populated (ids) — fields already reserved in `RunnerLogRow`. Backend unreachable → error logged in the audit row, maintenance results stand, zero partial candidates.

**Deferred from parent § 4 step 4:** the trust-tier input filter. Trust tiers aren't derivable yet (that's the emergent-trust arc); the input filter remains as today (own agent, non-archived, non-permanent, scope window). The safety net for un-tiered input is structural: candidates are staged, never auto-promoted.

### C. CLI

- `flair rem rapid` executes by default (staged-candidate summary + "review: `flair rem candidates` / `flair rem promote`"). `--prompt-only` preserves the old handoff output.
- `flair rem nightly run-once` exercises the same path.
- Config: `FLAIR_REM_MODEL` (or config-file equivalent) → passed as `opts.model`; unset uses Harper's default routing.

## § 4 Security & privacy

- **Inviolables unchanged** (parent § 2): snapshot before every nightly run; distillation only ever stages; promotion stays explicit with rationale + trust policy (parent § 5).
- **Data egress is a configuration decision:** with a local backend nothing leaves the box; pointing `models:` at a hosted provider sends memory content to that provider. Document this loudly next to the config recipe. Default posture: local.
- **Prompt injection via memory content:** a memory can contain adversarial text. Mitigations: candidates are inert data (never executed, never auto-promoted); schema validation; `sourceMemoryIds` subset check blocks linkage forgery; candidate/claim caps bound the blast radius.
- **Auth surface unchanged:** execute mode uses the same actor rules as prompt mode; no new endpoint.

## § 5 Out of scope (this slice)

- Hierarchical / recursive consolidation (summary trees) — rides this motor later; separate design.
- Trust-tier input filtering and any auto-promotion policy.
- Cross-agent / org-level REM.
- Streaming, tool use, per-call adapters.

## § 6 Verification

- Unit: stubbed `models` facade — happy path, malformed output (fail closed, zero rows), out-of-set `sourceMemoryIds` (candidate rejected), duplicate claims (skipped), no-backend (503, prompt mode still works), all-or-nothing staging.
- Runner: extend `test/rem-runner.test.ts` for step 5 (success populates `candidates`; backend failure logs error, maintenance results stand).
- Integration (env-gated, live local Ollama): `flair rem rapid` stages real candidates; `flair rem candidates` lists them; a promoted candidate becomes a persistent memory with `derivedFrom` intact.
- Full suite green before push (repo standard).

## § 7 Build plan

Two PRs, smallest committable slices:
1. **PR-1:** `/ReflectMemories` execute mode + validation + staging + tests (§ 3A).
2. **PR-2:** runner step 5 + CLI (`rapid` default flip, `--prompt-only`, `run-once`) + docs (config recipe incl. Ollama default and Fabric `enc:v1:` key handling) (§ 3B–C).
