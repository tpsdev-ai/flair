- **migrations: a failed `state.json` write is now logged and surfaced in `/HealthDetail`.**

  A migration's durable record — `<dataDir>/.migrations/state.json` — was written
  on the success path inside a `catch { /* best-effort */ }` with no log line, so a
  failed write left the migration reporting `completed` in `/HealthDetail`
  (in-memory, resets on restart) and everywhere else, while the one place a later
  boot, `doctor` or a test reads never got the entry. The failure was
  indistinguishable from "never ran".

  Every failed write is now logged at warn level with the migration id and the
  resolved path (`[flair-migrations] could not record <id> in <path>: <err>`), and
  the migrations detail in `/HealthDetail` carries
  `stateFile: { path, lastWriteError: { migrationId, at, message } | null }`
  (the path and the raw error message are redacted for non-admin callers),
  cleared on the next successful write. The write stays best-effort — the data
  outcome is unchanged and nothing rethrows.

  (Refs #1800)
