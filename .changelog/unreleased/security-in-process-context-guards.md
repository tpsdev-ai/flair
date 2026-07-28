- **The in-process API refuses to grant administrator access by accident.** `resolveAgentAuth` tests
  `tpsAgent` for truthiness, so a missing or empty agent id is indistinguishable from "no identity
  supplied" — which is flair's trusted `internal` verdict. Measured: `resolveAgentAuth({ request: {
  tpsAgent: undefined } })` returns `{ kind: "internal" }`, and `allowAdmin()` on that same context
  returns `true`. An embedding app whose `session.agentId` came back undefined would therefore have
  gained unfiltered cross-agent reads and writes, plus the admin-only gate, with no error and no log
  line.

  `resources/in-process.ts` is shaped so that cannot happen: `agentContext(id)` throws
  `InProcessContextError` on a missing, empty or blank id and takes **no options** (so no
  caller-influenced object spread into it can escalate); admin and the unfiltered verdict are separate
  named exports, `adminContext(id)` and `internalContext()`; and `collectionResource(Cls, context)`
  now requires its context rather than treating omission as `internal`. The privileged paths are the
  longest ones to type and are greppable by name. These are runtime guards, not type annotations — a
  plain-JavaScript embedder gets the same protection.

  The hazard itself is pinned as a test alongside the guards, so the guards cannot be simplified away
  without their justification failing in the same run.
