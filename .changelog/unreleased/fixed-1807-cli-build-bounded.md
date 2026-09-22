- **The CLI-build test helper can no longer hang a hook: it builds once, bounded and SIGKILLed (flair#1807).**

  Every unit file that needs `dist/cli.js` ran its own untimed build in a
  `beforeAll`. On the pinned bun the files of one `bun test` invocation run
  sequentially in one process (and CI runs each lane as one invocation), so the
  defect was not a race — it was serial redundancy and an unbounded child: a
  hung build was killed by the hook timer and reported with no name. The helper
  now skips the build when `dist/cli.js` is fresh against every input (`src/`,
  the `tsconfig.cli.json` chain, `package.json`, `bun.lock`,
  `scripts/write-build-info.mjs`), remembers a successful build for the rest of
  the process, and otherwise runs ONE build with a named timeout and
  `killSignal: "SIGKILL"` (a SIGTERM timeout does not stop a child that ignores
  it). The concurrency lock is deleted: it defended an execution model this bun
  does not have, and it could sleep with `Atomics.wait`, which bun's hook timer
  cannot interrupt. Every CLI build caller now routes through the helper.

  Case budgets were recomputed to exceed the SUM of the bounded waits that can
  run serially in a case (a case with three 20 s CLI runs is no longer held to a
  25 s budget), and one unbounded `fetch` in the fleet-presence fixture gained a
  named `AbortSignal.timeout`.

  > **Heads-up:** in CI nothing changes (both lanes pre-build); on a dev box the
  > build runs at most once per test process and a hung one is now named.

  (Refs #1807)
