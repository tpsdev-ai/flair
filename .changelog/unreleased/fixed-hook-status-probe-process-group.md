- **The `flair hook status` probe now ends every process its command started, not only the shell.**
  A command that timed out used to leave its descendants — an `npx`/`npm exec`
  helper, say — running after `status` returned. The probe runs the command in
  its own process group and terminates the whole group (SIGTERM, then SIGKILL
  after a short bounded grace) on the timeout path and after a normal exit
  (flair#2385).
