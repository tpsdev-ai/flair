- **Every home lookup in `src/` now goes through one resolver, so doctor and the writers agree on where `~` is.**

  Only the keystore and the client-config writers used `resolveHome()`; the rest of
  `src/` resolved home three other ways — `os.homedir()`, `process.env.HOME ?? homedir()`,
  and a private copy in `src/lib/uninstall-purge.ts`. `os.homedir()` is cached at process
  start, so a `HOME` set later in the process, which the writers honour, was invisible to
  them: in one process doctor could inspect a different home from the one the writers used.
  Every lookup now calls `resolveHome()` (an explicit `homeDir` override is kept where a
  function already took one), and a guard test fails if `src/` calls `homedir()` or reads
  `process.env.HOME` / `USERPROFILE` outside `src/lib/home.ts`. The only exceptions are the
  three `withHome()` harnesses that save and restore `HOME` to point an in-process call at
  an explicit home — a test/CLI override, not a home lookup.

  (Closes #1858)
