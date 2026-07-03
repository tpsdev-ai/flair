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
| `qwen3-reranker-0.6b-q8` (default) | `Qwen3-Reranker-0.6B-q8_0.gguf` | `Mungert/Qwen3-Reranker-0.6B-GGUF` (q8_0) | generative yes/no |
| `jina-reranker-v2` | `jina-reranker-v2-base.Q8_0.gguf` | `gpustack/jina-reranker-v2-base-multilingual-GGUF` (q8_0) | rank-pooling cross-encoder |

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
| `FLAIR_RERANK_MODEL` | `qwen3-reranker-0.6b-q8` | Model + inference mode (table above). |
| `FLAIR_RERANK_TOPN` | `50` | Candidate count fed to the reranker; caps the HNSW fetch. |
| `FLAIR_RERANK_BUDGET_MS` | `2500` | Hard latency budget; exceeded → vector order. |
| `FLAIR_RERANK_MIN_CANDIDATES` | `2` | Skip rerank below this many candidates. |

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

The `jina-reranker-v2` rank-API path (`createRankingContext()` / `rankAll`) works
inside Harper. See the integration PR for the live recall-bench A/B numbers and the
go/no-go read.
