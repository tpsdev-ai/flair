# REM responsiveness investigation (#1515, #1551)

The original five-minute outage with Gemma 4 has **not** been reproduced. A
populated nightly dedup sweep does reproduce HTTP starvation; the regression
and fix cover that defect, not the production incident's unproven root cause.

## Fixture

`test/integration-heavy/rem-responsiveness-1515.test.ts` starts an isolated
Harper 5.2.8 and a loopback fake Ollama server. It uses the real model adapter,
HTTP resources, and nightly runner. No production instance or real LLM is used.
Run after `bun run build && bun run build:cli`, with deployment environment
variables cleared as in the integration lane:

```sh
bun test test/integration-heavy/rem-responsiveness-1515.test.ts
```

A four-row control asserts one cluster of three live, identical vectors across
two owners, excluding an archived copy. Live rows cover both missing and false
archive flags. The CI fixture then grows to 403 live memories plus the archived
control (400 extra unique vectors). That is enough ANN work to exercise
yielding without the 3,065-row local repro, which exceeded CI's 60 s client
deadline. Synthetic 768-dimensional vectors use the installed embedding
model ID stamped to avoid background embedding generation. The runner snapshots
its own agent's rows and runs maintenance, generation, and instance-wide dedup.
The fake model delays two seconds and returns one candidate citing an actual
prompt source. Harper routes the string prompt through `/api/generate`.

During reflection and dedup, a separate process sends alternating `/Health`
and `/SemanticSearch` requests with two-second deadlines and a 50 ms pause
between probe pairs. Search uses a supplied vector. The test asserts successful
candidate staging, nonempty dedup results, and successful concurrent requests.
It is a responsiveness regression, not an ANN ranking benchmark or an LLM test.

## Observations

Local macOS, Node 24.15.0, Bun 1.3.13 (repository pin: 1.3.10), Harper 5.2.8;
final implementation based on Flair main `b0fa4a3` (0.51.2).

| Variant | Dedup time | Concurrent reads |
| --- | ---: | --- |
| Original gather on 3,065 seeded vectors | under 53 ms including probe settling | Misleading: instrumentation showed zero gathered rows |
| Corrected gather, yielding disabled (final regression fixture) | 20.99 s | Five health and five search requests timed out at 2 s; regression failed |
| Corrected gather with yielding (final regression fixture) | 23.07 s | No failures; maximum health 19.5 ms, search 47.6 ms |

Reflection with the delayed fake model took 2.27 s in the passing fixture;
maximum health latency was 181 ms and search 24.4 ms, with no failures.

The standalone `archived not_equal true` gather was the reason for the empty
sweep. In pinned Harper's `resources/search.ts`, the `ne` scan starts at `true`
and can still traverse the secondary index, omitting false/missing keys. Adding
the archive field to `select` or detaching the request transaction did not fix
it. Scanning primary rows and filtering archived records does.

The ANN loop's awaited cached reads can drain microtasks without letting HTTP
requests run. Yielding with `setImmediate` after approximately 10 ms of work
restores event-loop turns. It does not reduce total ANN work, make individual
queries preemptible, or impose a run-wide deadline. The existing 20,000-memory
sweep cap and aggregate response shape remain unchanged. The restored gather
now performs work that the faulty query silently skipped.

All figures are individual local observations, not throughput claims. Backend
behavior, real corpus geometry, concurrent workloads, and deployment topology
can differ. #1515 still needs incident evidence or a matching reproduction.
