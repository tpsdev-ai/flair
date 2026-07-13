# REM UX — trigger model, attach semantics, review loop

> Design note accompanying REM slice 2 (#707). Describes the intended user experience of in-process distillation so the CLI/docs surfaces stay coherent as the feature grows. Parent spec: `specs/FLAIR-NIGHTLY-REM.md`; slice spec: `specs/FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md`.

## Triggers — three, nothing implicit

1. **Interactive:** an agent (or a human at the CLI) runs `flair rem rapid` — one bounded distillation of that agent's own recent memories. Non-admin actors can only reflect on themselves; an admin can run it for any agent.
2. **Scheduled:** the nightly cycle, per agent, only where deliberately enabled (`flair rem nightly enable`). In a multi-node deploy, exactly one node gets the timer (see #709).
3. **Admin-run:** same endpoint, another agent's corpus, admin credentials.

REM never fires as a side effect of writes, searches, or boot. Distillation is always a deliberate act with an audit trail.

## Locality — the model call runs next to the data

The CLI is a thin HTTP trigger pointed at whatever Flair instance it is configured for (local or remote). Distillation executes **server-side** in the Flair component via Harper's model-access API. Consequences:

- Memory content never transits the operator's machine on its way to a model.
- Data egress is determined solely by the *server's* `models:` configuration — a local backend means nothing leaves the box; a hosted provider is an explicit, documented choice (keys ride Harper env-secret encryption on managed deploys).
- The same trigger UX works identically against a laptop instance and a managed deployment.

## Attach semantics — synchronous now, and the rule for when that changes

**Interactive mode stays attached.** One request, one bounded generate call (gather cap 50 memories, bounded output tokens), a staged-candidate summary printed on return. Seconds, not minutes — request/response is the honest shape for it, and `--prompt-only` preserves the bring-your-own-model handoff.

**Nightly mode is fully detached.** The scheduler fires the cycle; results land as pending candidates plus an audit row; the operator reviews next morning.

**The rule for revisiting:** any run shape that exceeds a single bounded generate call — hierarchical/recursive consolidation, org-level REM across many agents — gets a real job model (run id, `flair rem status <id>`, resumability) *designed before that slice ships*. The failure mode to avoid is a timeout bug forcing an ad-hoc job system into existence.

## The review loop — where REM's UX actually lives

Distillation is the cheap half; the reviewable stream of candidates is the product surface:

- **Today (CLI):** `flair rem candidates` lists pending rows; `flair rem promote <id> --rationale` / `flair rem reject <id> --reason` decide them. Every candidate carries its claim, source memory ids, generating model, and timestamp — enough to judge provenance at a glance.
- **Direction:** a reviewable feed — candidates as a stream with one-glance provenance and one-action promote/reject, recurring rejected claims surfaced via their `supersedes` chains rather than appearing fresh each time. The nightly diff report should point at that surface, making morning review a two-minute ritual instead of a CLI expedition.
- **Invariant either way:** nothing self-promotes. The feed can get faster and friendlier; the explicit-decision gate is load-bearing and stays.

## Configuration UX — one decision, one knob

Wanting REM should reduce to: *point the server's `models:` block at a backend.* Local Ollama works with zero credentials; a hosted provider takes an API key stored as an encrypted env secret. `FLAIR_REM_MODEL` selects a logical model name when the default routing isn't right. There is no REM-specific provider code, wiring, or plugin to install — if the server can `generate()`, REM works.
