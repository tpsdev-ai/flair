# LongMemEval_s — Layer 2 end-to-end benchmark (#1216-b)

The end-to-end memory benchmark: per question, ingest a multi-session history
into **real Flair**, retrieve context via Flair's **real BM25+RRF** retrieval,
have a **pinned reader** answer, and have a **pinned local judge** grade the
answer. It sits on top of the shared plumbing merged in #1216-a
(`packages/flair-bench/lib/`) — the same `ingestSessionHistory` /
`retrieveContext` the Layer 1 recall eval uses, so the two layers can never
diverge on how memories are written or read (a divergence would be a silent
confound).

**`configHash` is the anchor, and "verify it yourself" rests on it.** Everything
that can move the number is pinned and committed: the dataset (by HF commit +
sha256), the judge and reader (by Ollama manifest digest — tags are mutable,
digests are not), num_ctx, the retrieval config, the ingestion granularity, the
store topology, and the exact judge/reader prompt strings (all folded into the
config hash). Anyone with the repo re-derives `configHash` exactly, and re-runs
the same configuration with `ollama pull` — no OpenAI key, no per-run spend.

**"Verify it yourself" rests on `configHash` plus the exact prompts, the dataset
selection and the judge rubric — not on `artifactHash`.** `artifactHash` is a
*seal*: tamper-evidence for a signed-off artifact. It is not a reproducibility
proof and never was, even locally. Read
"[What 'reproducible' does and does not mean here](#what-reproducible-does-and-does-not-mean-here)"
below before quoting any of this at anyone.

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
### Model profiles — `LME_MODEL_PROFILE=local|cloud`

Two pinned model sets. `local` is the default, so an unset environment behaves
exactly as it always has.

| | `local` (default) — Newton | `cloud` — ollama.com |
|---|---|---|
| **Judge** | `gemma4:31b-it-q8_0`<br>`sha256:53dd8459790f8795177444daa9e33f417e03c0d1cdedb80b6c73898603d20aef`<br>weights `sha256:a0feadb7…` | `gemma4:31b`<br>`sha256:221b330d11a8`<br>weights `cloud-hosted:not-published` |
| **Reader** | `qwen3.6:27b-coding-mxfp8`<br>`sha256:a7185d39ff35a472a2721b87e1bbb90810bcd381d415666ce2137838e66f2780` | `qwen3.5:397b`<br>`sha256:b909ca2f1b7f` |

Both profiles keep judge family `gemma4` and reader family `qwen3_5`, so the
cross-family self-preference control holds either way rather than depending on
which profile you happened to run.

Judge settings are identical across profiles: temp 0, fixed num_ctx, and a
**plaintext** verdict (never Ollama's JSON/structured mode — non-deterministic
at fixed seed, Ollama #12559).

**The published headline run used `cloud`.** Those pins live here so a clean
checkout can reproduce the published `configHash`; before flair#1366 they
existed only as an in-place edit on the bench VM, which is what made the
headline unreproducible from the repo.

Selecting a profile is **artifact-affecting** and needs no extra hashed field:
`configManifest()` has always folded the whole judge/reader objects into the
hash, so the pins themselves carry the identity.

`test/unit/longmemeval-repro.test.ts` holds both properties — that the `cloud`
pins still reconstruct the published headline `configHash`, and that the `local`
pins are byte-for-byte what they were before profiles existed. It asserts them
on **pin values and a reconstructed historical manifest**, never on a pin of
"whatever the current manifest hashes to"; see "Reproducing a past run" below
for why that distinction is the whole design.

The harness **fails loud** if a model's current digest on the host does not
match the pinned digest, if the dataset sha256 does not match, if the judge
family equals the reader family, or if `LME_MODEL_PROFILE` is set to anything
other than a known profile name.

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

### Running against ollama.com (how the headline was produced)

```bash
LME_MODEL_PROFILE=cloud \
LME_OLLAMA_HOST=https://ollama.com \
LME_OLLAMA_KEY_FILE=$HOME/.config/ollama-api-key \
LME_ARMS=flair,vector-only \
bun run test/bench/longmemeval/run.ts run \
  --dataset ./longmemeval_s.json --n 500 --seed 0 --runs 1 \
  --records ./records.jsonl --progress ./progress.json
```

The API key is referenced **by path** and read in-process. It never appears in
argv, so never in shell history, `ps` output, or a transcript — and never in a
log line or the artifact. Unset ⇒ no auth header at all.

### Environment reference, and what each knob can move

Every variable is classified. The test being applied is *"can this change the
measured quantity while the harness is working correctly?"* — not *"does it
affect the run"*, which is true of all of them.

**Artifact-affecting** — must enter the hashed config, or two genuinely
different measurements collide on one `configHash`:

| variable | effect | how it is hashed |
|---|---|---|
| `LME_MODEL_PROFILE` | selects the judge/reader pins | via `manifest.judge` / `manifest.reader` — the pins themselves |
| `LME_ARMS` | which arms run | `manifest.arms` (`run.ts` records the SELECTED arms, not `ALL_ARMS`) |
| `LME_FULL_CTX` | full-context arm window | `manifest.fullContext` |
| *(implicit)* both Harper arms selected ⇒ shared-store ingest-reuse | store topology | `manifest.ingestion.harperStoreSharing` |

`LME_FULL_CTX` defaults to `131072`, the pinned publishable value. A ~100k-token
prefill is minutes per call, so a validation slice may reduce it (e.g. `16384`)
— the value used is folded into the config hash, so a reduced window is never
silent. Reduce it ONLY for validation.

The store-topology entry is the subtle one and is a **measurement-validity**
property, not an optimisation. See "Ingest-reuse" below.

**Operational-only** — cannot change the measured quantity under correct
operation; they govern whether the run completes, how fast, and what telemetry
it emits. If one of these ever moves a number, that is a bug to fix, not a
variant to hash — hashing it would content-address the breakage:

| variable | purpose | why it cannot move a number |
|---|---|---|
| `LME_OLLAMA_HOST`, `LME_OLLAMA_KEY_FILE` | endpoint + credentials | `assertModelPinned()` aborts unless the served digest matches the pin, so any endpoint either serves the pinned weights or the run stops |
| *(429/5xx backoff)* | cloud rate-limit resilience | the request body is byte-identical on every attempt at temp 0 / seed 0, so a retry turns "no answer" into the same answer; only 429 and 5xx retry, everything else still fails loud |
| `LME_RECORDS_JSONL` | per-eval JSONL journal | pure write-side observer — nothing reads it during a normal run, so no field it records can feed back into a result |
| `LME_RESUME=1` | resume from the journal | banked `(question, arm)` pairs are replayed, never re-evaluated, so the decision set is unchanged; `runHash` is resume-invariant (see caveat below) |
| `LME_PROGRESS_FILE` | machine-readable progress | write-only telemetry, never read back |
| `LME_INGEST_CONCURRENCY` | ingest parallelism (default 6) | memories are fully determined by the dataset, so the store end-state is identical at any concurrency |
| `LME_FLAIR_PKG_DIR`, `LME_HARPER_BIN_DIR` | locate the system under test | say *where* Flair lives, not how it behaves |
| `LME_BENCH_HOST` | provenance label | lands in the artifact's unhashed provenance partition |
| `LME_SHARED_COUNT_PROBE=1` | row-count probe logging | logging only |
| `LME_DETERMINISM_SAMPLES` | N for the reader-determinism probe (default 10, minimum 2) | the probe CHARACTERISES the reader on a fixed sample outside the measured slice; it never feeds an answer, a verdict or a metric, and its record is unhashed provenance |

### Ingest-reuse (shared store, alternating mode)

When both Harper arms are selected, one ingest per question serves both. This
exists for **validity**, not speed. Under the older whole-arm phasing the
`flair` arm ran over a store that grew question by question while `vector-only`
ran over an already-full-size store; filtered-ANN candidate recall degrades as
the HNSW graph grows, so `vector-only` faced a systematically harder task — an
asymmetry biased *toward* the result we would most like to be true. Alternating
the mode per question over one shared store makes both arms query the
byte-identical store state.

A shared-store run and a per-arm-store run therefore must never share a
`configHash`: one of them contains a confound, and hashing the topology is what
stops them being compared as if interchangeable. (It is also ~2× faster — the
reason it was reachable, not the reason it is correct.)

### Resume, and what the hashes actually guarantee

`runHash` content-addresses the run's **decisions** (answer / verdict /
tokensFed / extraction) and is resume-invariant: banked `(question, arm)` pairs
are replayed, never re-evaluated, so a resumed run and an uninterrupted one hold
the same decision set.

`artifactHash` covers the whole aggregate, which includes latency percentiles —
wall clock. So an artifact hash is not wall-clock invariant, and that is fine,
because **it is a seal rather than an identity to reproduce**. Banked journal
lines carry their original `latencyMs` so a resumed run replays latency
faithfully, but a journal written before that field existed falls back to `0`.

### What "reproducible" does and does not mean here

Be precise about this, because the claim is the product. There are three
identities and they carry three different strengths of claim. Lead with the
first one.

#### Tier 1 — `configHash`: the anchor, re-derivable by anyone

A pure function of the pinned config, so any checkout with the same profile and
slice derives it **exactly**. It survives cloud nondeterminism because it hashes
*configuration*, not output. This is what "did they run what they said they ran"
actually rests on, and the reproduction of the published headline `configHash`
from repo code is asserted in `test/unit/longmemeval-repro.test.ts`.

#### Tier 2 — `runHash`: the decision set, statistical under `cloud`

Content-addresses answer / verdict / tokensFed / extraction. Under `local` it is
*expected* to re-derive — **expected, not measured**, so it is not claimed.
Under `cloud` the answer *text* is not bitwise-stable, so `runHash` does not
re-derive. The honest claim there: *accuracy is a statistical result — re-run
and compare within variance; completion text is not bitwise-stable.* The
variance to compare against is published in the artifact — see
[the reader-determinism probe](#the-reader-determinism-probe) below.

#### Tier 3 — `artifactHash`: a seal, not a proof

It detects post-hoc modification of an artifact a human signed off on. **It is
not reproducibility evidence and never was, even locally** — it covers wall-clock
latency percentiles and, through the run hashes, completion text.

So: **"verify it yourself" rests on `configHash` plus the exact prompts, the
dataset selection and the judge rubric — not on `artifactHash`.**

#### Reproducing a past run as the harness evolves

The manifest **is expected to grow** — every new measurement variant adds a
field, and #1364's `prompts.readerPayloadFormat` is the first example. That
creates an obvious tension: an old artifact's `configHash` was computed over a
manifest that did not have the new field, so current code cannot emit that hash
directly.

The resolution is that a historical run is reproduced by **reconstructing the
manifest as that run recorded it** — projecting the current manifest onto
exactly the key set the artifact carries — and checking the reconstruction
hashes to the recorded `configHash`. `test/unit/longmemeval-repro.test.ts` does
this for every artifact in `results/`, and the behavior is deliberately
asymmetric:

- **a field is added** — the projection drops it, the old hash still reproduces,
  nothing needs rewriting. The new field still governs the identity of *new*
  runs through the normal `configHash` path.
- **a pinned value the old run depended on changes**, or **a field it had is
  removed** — the reconstruction fails, because that genuinely means the repo
  can no longer express the configuration behind a published number.

So the rule when that test fails: **do not re-pin the expected hash and do not
relax the projection.** Either the change was unintended, or the affected
headline must be re-run and its artifact replaced — a real decision with a real
cost, which is exactly what the test is there to force.

Adding a new headline? Commit its artifact to `results/` and add a row to
`HISTORICAL_VARIANTS`. Old rows stay; the repo accumulates the ability to
reproduce every number it has published.

**Reproducible in practice:** the assembled reader prompt. A clean-checkout
`n=2` run reproduced the headline run's `tokensFed` exactly — 3174 / 3159 /
4548 / 4722 across four `(question, arm)` pairs — i.e. retrieval and payload
formatting are byte-faithful.

**NOT reproducible under the `cloud` profile:** `runHash`, because it
content-addresses the reader's answer text and **the cloud reader is not
deterministic at temperature 0 / seed 0**. Measured directly on
`qwen3.5:397b` via ollama.com: four calls with a byte-identical prompt
(32 prompt tokens each) returned **three distinct completions**, diverging
after a 68-character common prefix ("Two is unusual…" vs "The number 2 is
unusual…"). This is a property of batched cloud inference — MoE routing and
mixed-precision kernels are not bitwise-stable across batch composition — not
of this harness.

The practical consequence: under `cloud`, two faithful runs of the same config
agree on what was measured and on the questions asked, and their **verdicts**
agreed 4/4 in the sample above, but their `runHash` and `artifactHash` will
differ. A published cloud number is a *statistical* result to be re-run and
compared within variance, not a hash anyone can re-derive — which is why the
run count and the reported std matter.

At `--runs 1` there is **no** std to report, and the harness says so rather than
printing one. `std` is `null` (never `0`), the arm aggregate carries
`varianceMeasured: false`, and the headline renders
`66.0% (single run — variance unmeasured)` instead of `66.0% ± 0.0%` (flair#1376).
A zero would be indistinguishable from "we ran it repeatedly and it agreed
perfectly", which is the opposite of what a single run establishes.

The `local` profile runs single-stream against a pinned local digest and is
expected to be closer to bitwise-stable, but that has **not** been measured;
do not claim it without a measurement. (The cloud *judge* returned an identical
verdict 4/4 in the same probe, but on a trivial 16-token prompt — that is not
evidence of judge determinism on real rubric prompts.)

### The reader-determinism probe

*"Re-run and compare within variance"* is an **empty instruction unless the
variance is published.** Someone re-running this benchmark against the same cloud
reader will get different completion text than we did; without a published
determinism measurement they cannot tell whether their divergence is normal or
evidence that we got something wrong.

So every run measures it and records it (`determinism.ts`, flair#1368). Per
probed question:

| field | meaning |
|---|---|
| `samples` | **N** — repeated calls with a byte-identical prompt (default 10) |
| `distinctCompletions` | **M** — unique completion strings across the N calls |
| `commonPrefixLength` | characters every completion shares before the first divergence |
| `verdictAgreementRate` | (count of the modal verdict) / N — an unparseable verdict is its own bucket, never folded into a real one |

Plus `questionIds` (the fixed sample), the resolved `reader` pin, and
`promptConstruction`. A `summary` rolls the questions up with the aggregation
named in each field: `maxDistinctCompletions`, `minCommonPrefixLength`,
`minVerdictAgreementRate`.

Four properties make the numbers worth comparing, and each is enforced rather
than asked for:

- **Identical reader configuration.** The probe issues `buildReaderRequest()`
  from `eval.ts` — the single definition of a reader call that the main run also
  issues — and calls `readerAnswer()` / `judgeOne()` themselves. It takes no
  reader parameters of its own, so there is nothing to set on one path and
  forget on the other. A probe that quietly measured different settings would be
  *worse* than no probe, because its numbers would look authoritative.
- **Fixed question sample.** `PROBE_QUESTION_IDS` is a hardcoded constant, not a
  draw from the run's slice. A sample that moved per run would make probes
  incomparable across runs — the one property the probe exists to provide. The
  ids are written into the artifact, and a probe id missing from the dataset is
  fatal, never a silent skip. **Changing that list breaks comparability with
  every probe already published**; treat it as a new measurement if you must.
- **Unhashed provenance.** The record lands in the artifact's provenance
  partition. Determinism legitimately differs run to run, so if it fed
  `artifactHash`, every honest re-run would look like tampering. Asserted, not
  assumed (`test/unit/longmemeval-artifact.test.ts`).
- **The judge is never sampled.** All N completions are scored.

**Limitation, stated because it is real.** The probe does not retrieve from a
live Flair. It builds a retrieval-*shaped* context deterministically from the
question's own haystack and formats it through the harness's own pinned payload
formatter, so the probe prompt is a pure function of (dataset, question id,
pinned prompts, pinned payload format, `readerTopK`) and a re-runner rebuilds it
**byte-identically** without needing our store or our index state. That
reproducibility is the point — a probe whose own input could not be reproduced
would not support the comparison it exists for. The trade is that the context is
the same *shape* and comparable size as a real retrieval payload, not the same
*content*.

`LME_DETERMINISM_SAMPLES` raises or lowers N; the value used is recorded next to
every number it produced. Below 2 is fatal rather than clamped — one call cannot
measure agreement between calls, and "1 distinct completion" from a single
sample would be a fabricated determinism claim.

A failed probe is recorded **as an error in the artifact**, not omitted: "we did
not probe" and "we probed and it broke" are different facts, and a probe failure
does not abort the measurement run.

## The publish gate is structural

The run emits a **content-addressed artifact** (`artifact.ts`): config hash +
per-run hashes + the numbers, addressed by `artifactHash`. There is **no
`--publish` flag** and no publish function. Publishing any number is a separate,
gated human decision recorded against a specific `artifactHash` — spend and
outward-publishing are the founder's gates. The full ≥5×500 publishable run is a
separate gated execution; the default `--runs`/`--n` here are sized for
validation.

What the hash does *for this gate*: it binds a sign-off to one exact set of
numbers, so "approved to publish artifact `<hash>`" cannot later be attached to
a different set. That is tamper-evidence — a **seal**, not a reproducibility
proof. Anyone checking that we ran what we said we ran should check
`configHash`.

## Isolation

Each run spawns a **fresh ephemeral Harper** per Harper-arm
(`test/helpers/harper-lifecycle`), which HOME-isolates itself to a temp dir —
ingest **never** touches production `~/.flair` / `:9926`. Runs are independent
(fresh instance, fresh ingest), so the ≥5-run std reflects real variance.
