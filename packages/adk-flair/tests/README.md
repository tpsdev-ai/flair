# adk-flair Integration Tests

Integration tests that require a live Flair instance. These tests validate
the adapter against a real Flair server — they are **not** run in CI (no live
Flair available) but are executed during verification on rockit.

## Quickstart

```bash
# 1. Start a Flair instance (or use an existing one)
#    Option A: Let the test harness boot an ephemeral Harper
#    Option B: Point at an existing instance with FLAIR_TEST_URL

# 2. Run the integration tests
cd packages/adk-flair
FLAIR_TEST_URL=http://localhost:19926 pytest tests/ -m live_flair -v
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `FLAIR_TEST_URL` | yes* | — | Flair HTTP URL (e.g. `http://localhost:19926`) |
| `FLAIR_TEST_OPS_URL` | no | derived (port-1) | Flair ops API URL |
| `FLAIR_TEST_ADMIN_USER` | no | `admin` | Admin username for agent registration |
| `FLAIR_TEST_ADMIN_PASS` | no | `test123` | Admin password for agent registration |
| `FLAIR_TEST_AGENT_ID` | no | auto-generated | Agent ID to register |
| `ADK_TEST_MODEL` | no | — | LiteLLM model string for agent-loop tests (test 3) |

> **Tool-capable model required:** `test_cross_session_recall` sends tools
> (PreloadMemoryTool) to the model. Models that do not support tool-calling
> will fail — e.g. `ollama_chat/qwen3.6:27b-coding-mxfp8` returns `{error: EOF}`
> when ADK sends tools. Use a tool-capable model such as
> `ollama_chat/qwen3-coder-next:latest` (~37s full loop).
| `NODE_BIN` | no | `node` | Node.js binary (for ephemeral Harper boot) |

\* `FLAIR_TEST_URL` is required unless you let the harness boot an ephemeral
Harper (requires Node.js and the repo's `harper-lifecycle` helper).

## Ephemeral Harper Boot

When `FLAIR_TEST_URL` is not set, the test harness attempts to boot an
ephemeral Harper instance via `tests/helpers/boot-harper.mjs`, which uses the
repo's `test/helpers/harper-lifecycle.ts` module. This requires:

- Node.js available as `node` (or set `NODE_BIN`)
- `bun install` run at the repo root (for Harper dependency)
- The `harper-lifecycle` module to be importable

The ephemeral instance is automatically torn down after the test session.

## Running Against an Arbitrary Flair URL

```bash
# Against a local Flair
FLAIR_TEST_URL=http://localhost:19926 pytest tests/ -m live_flair -v

# Against a remote Flair (with admin credentials)
FLAIR_TEST_URL=https://flair.example.com:19926 \
FLAIR_TEST_OPS_URL=https://flair.example.com:19925 \
FLAIR_TEST_ADMIN_USER=admin \
FLAIR_TEST_ADMIN_PASS=your-password \
pytest tests/ -m live_flair -v

# With model-dependent tests (test 3 agent loop)
ADK_TEST_MODEL=openai/gpt-4o-mini \
FLAIR_TEST_URL=http://localhost:19926 \
pytest tests/ -m live_flair -v
```

## Test Files

### `test_explain_plan.py` — Harper Explain Plan (Test 1)

Writes >=3 simulated users x >=50 memories each through the adapter, then
asserts that a compound `adk:<app>:<user>` tag search returns ONLY the target
user's memories — the positive control for the pre-filter isolation property.

### `test_portability.py` — Portability Proof (Test 2)

Verifies Spec Scenario 4:
- Memory written via ADK adapter (`add_memory`, `add_session_to_memory`) is
  found by a direct Flair REST search authenticating as the same app principal
- Memory written via direct Flair REST is found by the ADK adapter

### `test_quickstart_parity.py` — Quickstart Parity (Test 3)

Executes the Memory Bank ADK quickstart flow with `FlairMemoryService`:
- `test_provision_and_write` — provisions Flair, writes session 1 memories
  (no model required)
- `test_cross_session_recall` — cross-session recall (requires `ADK_TEST_MODEL`)
- `test_agent_loop_boundary` — validates everything up to the model-call boundary

## Skipping Behavior

Tests marked `@pytest.mark.live_flair` **SKIP with a visible reason** when no
live Flair is configured. A skip must never look like a pass in output:

```
SKIPPED [1] tests/test_explain_plan.py: FLAIR_TEST_URL not set and ...
```

Run without the marker to execute only unit tests:

```bash
pytest tests/ -m "not live_flair" -v
```
