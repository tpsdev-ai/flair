# adk-flair-js tests

## Unit tests

```bash
bun test packages/adk-flair-js/test/unit/
```

No external dependencies — pure mock-based tests for the memory service,
signing, tag helpers, and constructor validation.

## Integration tests

```bash
bun test packages/adk-flair-js/test/integration/
```

Requires a live Flair instance. The test helper auto-boots one via Harper
(ephemeral mode) or connects to `FLAIR_TEST_URL` (external mode). See
`test/helpers/live-flair.ts` for details.

### Model-dependent tests

The `quickstart_parity` agent-loop test requires a model. Set
`ADK_TEST_MODEL` to a LiteLLM-style model string:

```bash
# Google Gemini (built-in adk-js support)
ADK_TEST_MODEL=gemini-2.5-flash bun test ...

# Self-hosted Ollama (via test/helpers/ollama-llm.ts)
ADK_TEST_MODEL=ollama_chat/llama3.2 bun test ...
```

**Note:** `@google/adk` v1.6.0 ships only `Gemini` and `ApigeeLlm` in its
built-in model registry. There is no built-in non-Google model class. The
`test/helpers/ollama-llm.ts` helper exists to bridge this gap — it registers
a minimal `OllamaLlm extends BaseLlm` that speaks plain `/api/chat`
completions against `OLLAMA_API_BASE` (default `http://localhost:11434`).

The `ollama_chat/` prefix is stripped to derive the Ollama model name.
No tool/function-calling support is needed because the quickstart-parity
agent loop only uses `PreloadMemoryTool` (a processor-level tool that never
reaches the model).

When `ADK_TEST_MODEL` is not set, the agent-loop test SKIPs with a visible
reason. All other tests (provisioning, write paths, cross-session recall
without a model) still run.
