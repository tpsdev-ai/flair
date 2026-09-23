- **Every home lookup in `src/` now goes through one resolver, so doctor and the writers agree on where `~` is.**

  Only the keystore and the client-config writers used `resolveHome()`; the rest of
  `src/` resolved home three other ways — `os.homedir()`, `process.env.HOME ?? homedir()`,
  and a private copy in `src/lib/uninstall-purge.ts`. `os.homedir()` is cached at process
  start, so a `HOME` set later in the process, which the writers honour, was invisible to
  them: in one process doctor could inspect a different home from the one the writers used.
  Every lookup now calls `resolveHome()` (an explicit `homeDir` override is kept where a
  function already took one), and a guard test fails if `src/` calls `homedir()` or reads
  `process.env.HOME` / `USERPROFILE` outside `src/lib/home.ts`. The `withHome()`
  override now lives there too: it sets BOTH `HOME` and `USERPROFILE`, so an
  explicit home is honoured on Windows as well — the three private copies set only
  `HOME`, which `resolveHome()` ignores on win32, so doctor, the pin refresh and
  uninstall's unwire() acted on the real profile instead of the caller's home.
  The allow-list is empty.

  (Closes #1858)
