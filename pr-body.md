## What changed

**resources/MemoryFeed.ts** — `FeedMemories.post()` now resolves the authenticated principal via `resolveAgentAuth()` and stamps `agentId` from the principal using the kit's `stampAttribution()` in **stamp-strict** mode. Body-supplied `agentId` is no longer trusted: a mismatched value is rejected with 403 rather than silently overwritten. Additionally, a body-supplied record `id` is checked against the existing record's ownership before allowing the write.

**test/unit/memory-feed-idor.test.ts** — Pure logic tests for the attribution-stamping and id-ownership guard (4 tests, no Harper needed).

**test/integration/memory-feed-idor.test.ts** — Live Harper integration tests: guard against IDOR via body agentId spoofing and cross-agent record targeting, positive controls for own writes, and anonymous rejection.

## Why

The previous `post()` read `agentId` directly from `content.agentId` in the request body. A verified agent could feed a memory attributed to any `agentId` by including it in the body — even if the authenticated principal was different. A body-supplied `id` targeting another agent's record would silently overwrite it.

## The fix

1. **Resolve the authenticated principal** via `resolveAgentAuth()` at the start of `post()`.
2. **Stamp `agentId` from the principal via `stampAttribution(stamp-strict)`** — rejects body-supplied `agentId` mismatches with 403. A caller sending another agent's id is either buggy or probing, and both are worth surfacing rather than silently correcting.
3. **Guard body-supplied `id`** — if the body includes a record `id`, fetch the existing record and reject with 403 if its `agentId` differs from the stamped principal.
4. **Reject anonymous writes** — `UNAUTH()` for unauthenticated callers.

## Why stamp-strict over stamp-default

stamp-default silently overwrites a forged `agentId` with the principal's. stamp-strict rejects the mismatch with 403. This endpoint's entire defect was trusting body-supplied identity — a caller sending another agent's id is either buggy or probing, and both are worth seeing.

The risk with strict is breaking legitimate callers that echo `agentId` back in the body. **Verified: no such callers exist.** A full search of the flair repo (and the workspace) for `FeedMemories` and `/FeedMemories` returns only the resource definition itself and its own tests. There are no SDK wrappers, no CLI commands, and no internal callers that construct requests to this endpoint with a body-supplied `agentId`. The endpoint is consumed exclusively via HTTP POST by agents, and the only body shape that reaches it is whatever the agent sends. A caller echoing the *correct* agentId (matching the principal) passes through stamp-strict unchanged; a caller echoing a *wrong* one is exactly the bug this slice exists to prevent.

## Mutation-verify

Reverting `MemoryFeed.ts` to the body-trusting version (`const agentId = String(content?.agentId ?? "");`) allows a principal to feed a memory attributed to another agent via body agentId spoofing. The integration guard tests catch this.
