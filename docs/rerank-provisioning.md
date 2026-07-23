# Reranker model provisioning

Flair's optional cross-encoder rerank stage (`resources/rerank-provider.ts`, gated
behind `FLAIR_RERANK_ENABLED`) loads its model GGUF **in-process** via the same
node-llama-cpp engine the embedding engine ships. The GGUF is **not** committed to
the repo (`*.gguf` is gitignored) — it is provisioned into `models/` manually,
exactly like the embedding model.

The reranker is **OFF by default**. You only need to provision a GGUF if you are
turning it on (`FLAIR_RERANK_ENABLED=true`) or running the recall-bench A/B.

## Models

| `FLAIR_RERANK_MODEL` | GGUF filename (under `models/`) | Source | Inference mode |
|---|---|---|---|
| `jina-reranker-v2` (**default**, working) | `jina-reranker-v2-base.Q8_0.gguf` | `gpustack/jina-reranker-v2-base-multilingual-GGUF` (q8_0) | rank-pooling cross-encoder |
| `qwen3-reranker-0.6b-q8` (**experimental** — see Known limitation) | `Qwen3-Reranker-0.6B-q8_0.gguf` | `Mungert/Qwen3-Reranker-0.6B-GGUF` (q8_0) | generative yes/no |

Download into `models/` next to the embedding GGUF, e.g.:

```sh
# quality model (Qwen3 generative path)
huggingface-cli download Mungert/Qwen3-Reranker-0.6B-GGUF \
  Qwen3-Reranker-0.6B-q8_0.gguf --local-dir models/

# latency model (jina rank API)
huggingface-cli download gpustack/jina-reranker-v2-base-multilingual-GGUF \
  jina-reranker-v2-base.Q8_0.gguf --local-dir models/
```

If the GGUF is missing, the provider logs one warning and recall falls back to
vector order — it never blocks or breaks search.

## Config

| Env var | Default | Meaning |
|---|---|---|
| `FLAIR_RERANK_ENABLED` | unset (**OFF**) | Master flag. `"true"` to enable. |
| `FLAIR_RERANK_MODEL` | `jina-reranker-v2` | Model + inference mode (table above). Re-read on every rerank call — changing it takes effect on the NEXT call (that call pays a one-time model-(re)load cost and can itself fall back to vector order if the load exceeds `FLAIR_RERANK_BUDGET_MS`; subsequent calls run at normal latency). |
| `FLAIR_RERANK_TOPN` | `50` | Candidate count fed to the reranker; caps the HNSW fetch. |
| `FLAIR_RERANK_BUDGET_MS` | `2500` | Hard latency budget; exceeded → vector order. |
| `FLAIR_RERANK_MIN_CANDIDATES` | `2` | Skip rerank below this many candidates. |

Candidate document (and query) text is truncated to a per-model context budget
before it ever reaches the engine — see `resources/rerank-provider.ts`'s file
header ("Context-budget truncation"). This is not operator-configurable
(the budgets are derived from each mode's fixed context size); flagged here
only so a truncated rerank input isn't a surprise.

## Why this serving path (not Ollama, not a microservice)

- **In-process node-llama-cpp** is the same engine the embedding engine already
  ships — no new infra, no network hop, no auth boundary. The reranker GGUF lives
  next to the embedding GGUF and loads via the same addon-discovery pattern as
  `embeddings-provider.ts`.
- **Ollama is out:** it has no rerank endpoint and silently drops next-token
  logprobs, so it can serve neither the jina rank path nor the Qwen3 generative
  yes/no path. (Verified live against newton's Ollama 0.30.10.)

## Known limitation — Qwen3 generative path inside Harper

The Qwen3 generative path scores `P(yes)/(P(yes)+P(no))` via node-llama-cpp's
`controlledEvaluate` with next-token probabilities. This works standalone and in a
plain Node worker thread, but **inside Harper's resource runtime — where HFE's
embedding engine has already initialized a separate native llama backend —
`controlledEvaluate` returns an empty result (no decoded logits).** The provider
detects this (`out.length === 0`), throws, and **fails open to vector order** (it
never writes corrupt scores). Net effect today: with `FLAIR_RERANK_MODEL=qwen3-...`
the rerank stage cleanly no-ops inside Harper.

flair#811 (the live-corpus Phase-1 gate) found the qwen3 path erroring on every
call in production and root-caused two compounding issues, fixed in that PR:

1. **Context overflow on real documents.** The offline pilot's 16-doc fixture was
   short synthetic prose; real memory content routinely exceeds either model's
   small context window (1024 tokens for the generative context, 2048 for the
   rank context). `resources/rerank-provider.ts` now truncates every (query, doc)
   pair to a budget derived from each mode's actual context size before it ever
   reaches the engine (see that file's header). This doesn't fix the dual-backend
   empty-logits limitation above, but it removes overflow as a SEPARATE, more
   easily hit failure mode — and may have been a contributing cause of the
   empty-logits symptom itself (an overflowing `controlledEvaluate` call doesn't
   throw the way `rankAll` does; it's plausible an oversized prompt silently
   context-shifted rather than decoding cleanly, though we couldn't confirm
   this without a live repro).
2. **Config not re-read after first init.** The provider used to cache which
   model was loaded PERMANENTLY on first successful (or failed) init — a later
   change to `FLAIR_RERANK_MODEL` had no effect until the process restarted, so
   "configured model X, served model Y" could persist silently for the life of
   the process. Now re-validated on every call (`needsReinit()`); a config
   change is picked up on the next rerank.

**Given the above, `jina-reranker-v2` is now the DEFAULT model** — its rank-API
path (`createRankingContext()` / `rankAll`) completes inside Harper. `qwen3` stays
selectable and documented for whoever revisits the dual-backend isolation
question; it is not the default until the empty-logits limitation is actually
fixed (truncation alone doesn't fix it — see point 1 above, it only removes a
compounding cause).

See the integration PR / flair#811 for the live recall-bench A/B numbers and the
go/no-go read on `jina-reranker-v2` as the default.
