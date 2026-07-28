- **`flair upgrade` could install the new version, fail to restart, and leave Flair
  down behind an error that named the wrong fix.** Upgrading 0.29.0 → 0.30.0 ended
  at `restart failed: Harper binary not found. Run 'flair init' first.`, exit 1,
  with the instance stopped — while the binary was present and `flair start`
  recovered a healthy install immediately. The mechanism is the package swap
  itself: `flair upgrade` replaces `@tpsdev-ai/flair`'s tree *while the CLI is
  executing out of it*, so everything after that point is old code reasoning about
  a new tree. 0.30.0 had renamed its Harper dependency `@harperfast/harper` →
  `harper` (the ~104 MB dedupe in 0.30.0), 0.29.0's resolver only ever probed the
  old name, and the name it wanted was genuinely gone. Nothing was lost — the data
  directory is never touched by a package swap — but an operator was left with a
  stopped instance and a message pointing at `flair init`, which on an initialised
  instance is the one command you least want someone running at 3am.

  Three fixes, because the single failure exposed three separate gaps:

  **The restart now runs through the newly installed CLI**, resolved from disk
  after the swap and version-checked before it is trusted. Only version N's own
  code knows how version N starts; spawn arguments, required environment, config
  templates and dependency names are all things a release may change, and the
  pre-swap process would get each of them wrong the same silent way. A CLI that
  cannot be located or confirmed falls back to an in-process restart and says so
  rather than refusing to start anything, as does an upgrade of a non-default data
  directory — `flair restart` has no `--data-dir`, so delegating one would restart
  a different instance. As defence in depth, the Harper binary is
  now located by reading the package name out of the post-swap `package.json`
  instead of a compiled-in list, so a future rename cannot reproduce this class.

  **Rollback now actually runs on a failed restart.** `docs/upgrade.md` has
  promised "install → restart → verify → rollback-on-failure, in one step" since
  flair#635, but the rollback was only ever wired to the *verification* leg — a
  restart failure went straight to `process.exit(1)`. An upgrade that installs new
  packages and then cannot start them is precisely the case the transaction exists
  for. It now reinstalls the previous version, restarts on it, and re-verifies,
  through the same path a verification failure takes.

  **The error names a remedy that works.** `Harper binary not found` now lists
  every path that was searched and points at reinstalling the package, and states
  plainly that `flair init` will not fix it. A failed restart says the instance is
  not running, that `~/.flair` was not touched, and gives `flair start`.

  Regression coverage closes the gap that let this ship: CI's upgrade lane installs
  a baseline, stops it, installs HEAD into a *fresh* directory and starts that — it
  never invoked `flair upgrade`, and nothing anywhere asserted the instance was
  still reachable afterwards. Exit status was never the gap; this failure exits 1,
  loudly. `test/compat/upgrade-restart-liveness.test.ts` performs a real
  cross-version upgrade against a real running instance in an isolated npm prefix
  and asserts `/Health` answers when it is over.

  **If you are on 0.29.0 today**, the fix cannot reach you: the code that performs
  the restart is the version you are upgrading *from*. Run `flair start` after the
  upgrade and you are on 0.30.0, healthy — see `docs/upgrade.md` for the full note.
