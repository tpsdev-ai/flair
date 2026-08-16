# LongMemEval_s — Layer 2 end-to-end benchmark (#1216-b)

The end-to-end memory benchmark: per question, ingest a multi-session history
into **real Flair**, retrieve context via Flair's **real BM25+RRF** retrieval,
have a **pinned reader** answer, and have a **pinned local judge** grade the
answer. It sits on top of the shared plumbing merged in #1216-a
(`packages/flair-bench/lib/`) — the same `ingestSessionHistory` /
`retrieveContext` the Layer 1 recall eval uses, so the two layers can never
diverge on how memories are written or read (a divergence would be a silent
confound).

**Reproducibility is the edge.** Everything that can move the number is pinned
and committed: the dataset (by HF commit + sha256), the judge and reader (by
Ollama manifest digest — tags are mutable, digests are not), num_ctx, the
retrieval config, the ingestion granularity, and the exact judge/reader prompt
strings (folded into the config hash). Anyone re-runs the exact number locally
with `ollama pull` — no OpenAI key, no per-run spend.

## Arms

| arm | context fed to the reader | role |
|-----|---------------------------|------|
| `flair` | BM25+RRF hybrid retrieval, documented defaults | the headline |
| `vector-only` | the same retrieval with BM25 disabled (pure HNSW) | ablation |
| `full-context` | the entire haystack (own larger, pinned num_ctx) | ceiling + **memory-validity check** |
| `no-context` | nothing — only the question | **contamination probe** |

Reader and judge are the **same across all arms** — only the context differs.

- `no-context` high ⇒ the reader is answering from prior knowledge /
  contamination, and the number is suspect.
- `full-context ≈ flair` ⇒ the benchmark is measuring long-context, not memory;
  a large `full-context − flair` gap ⇒ retrieval is losing relevant information.

## Pinned components

- **Dataset:** LongMemEval_s, HF `xiaowu0162/longmemeval` @
  `2ec2a557f339b6c0369619b1ed5793734cc87533`, file `longmemeval_s`,
  sha256 `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`.
  Judge prompts ported from `xiaowu0162/LongMemEval` @
  `9e0b455f4ef0e2ab8f2e582289761153549043fc`
  (`src/evaluation/evaluate_qa.py`).
- **Judge:** `gemma4:31b-it-q8_0`, LOCAL on Newton via Ollama, manifest digest
  `sha256:53dd8459790f8795177444daa9e33f417e03c0d1cdedb80b6c73898603d20aef`.
  temp 0, fixed num_ctx, **plaintext** verdict (never Ollama's JSON/structured
  mode — non-deterministic at fixed seed, Ollama #12559).
- **Reader:** `qwen3.6:27b-coding-mxfp8` (Qwen family — a **different family**
  than the Gemma judge, the self-preference control), digest
  `sha256:a7185d39ff35a472a2721b87e1bbb90810bcd381d415666ce2137838e66f2780`.

The harness **fails loud** if a model's current digest on the host does not
match the pinned digest, if the dataset sha256 does not match, or if the judge
family equals the reader family.

## Grading

The SimpleQA ternary — **CORRECT / INCORRECT / NOT_ATTEMPTED** — carrying
LongMemEval's expert per-task rubric text (off-by-one leniency for temporal;
subset-of-the-answer is wrong; updated-answer-present is right for
knowledge-update; a rubric for preference; the unanswerable framing for
abstention). The verdict is parsed as a **plaintext exact enum** (A/B/C);
anything the parser cannot resolve to a single allowed letter is a **judge
error**, never a silent pass. Headline accuracy = CORRECT / judged;
`NOT_ATTEMPTED` on an answerable question is broken out separately, and
abstention questions are reported as their own bucket.

An **independent F1/EM cross-check** (`extraction.ts` — pure SQuAD-style string
math, NOT the LLM judge) runs on the factual subset (IE, multi-session,
temporal, knowledge-update). A large judge-vs-F1 gap is the tell for a lenient
judge (the LightRAG cautionary case).

## Get the dataset (pinned)

Not committed to the repo (278 MB, HF LFS). Fetch it pinned:

```bash
curl -sL \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/2ec2a557f339b6c0369619b1ed5793734cc87533/longmemeval_s" \
  -o longmemeval_s.json
shasum -a 256 longmemeval_s.json
# expect: 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
```

## Run

```bash
# 0. build (Harper serves resources from dist/)
bun run build

# 1. prove the judge: correct + DETERMINISTIC ternary verdicts on known pairs
bun run test/bench/longmemeval/run.ts verify-judge --repeats 3

# 2. run a slice over the four arms → content-addressed artifact
bun run test/bench/longmemeval/run.ts run \
  --dataset ./longmemeval_s.json --n 24 --seed 0 --runs 5
```

`LME_OLLAMA_HOST` overrides the Ollama endpoint (default Newton
`http://192.168.2.64:11434`).

`LME_FULL_CTX` overrides the full-context arm's window (default `131072`, the
pinned publishable value). A ~100k-token prefill is minutes per call, so a
validation slice may reduce it (e.g. `LME_FULL_CTX=16384`) — the value used is
folded into the config hash and recorded in the artifact, so a reduced window is
never silent. Reduce it ONLY for validation; the publishable run uses the pinned
default.

## The publish gate is structural

The run emits a **content-addressed artifact** (`artifact.ts`): config hash +
per-run hashes + the numbers, addressed by `artifactHash`. There is **no
`--publish` flag** and no publish function. Publishing any number is a separate,
gated human decision recorded against a specific `artifactHash` — spend and
outward-publishing are the founder's gates. The full ≥5×500 publishable run is a
separate gated execution; the default `--runs`/`--n` here are sized for
validation.

## Isolation

Each run spawns a **fresh ephemeral Harper** per Harper-arm
(`test/helpers/harper-lifecycle`), which HOME-isolates itself to a temp dir —
ingest **never** touches production `~/.flair` / `:9926`. Runs are independent
(fresh instance, fresh ingest), so the ≥5-run std reflects real variance.
