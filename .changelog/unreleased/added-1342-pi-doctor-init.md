- **`flair doctor` and `flair init` now know pi.** pi joins the client registry
  as a native-extension host (pi has no MCP client support): detection is the
  `pi` binary on PATH or `~/.pi/agent/settings.json` present, and
  `flair init --client pi` wires a pinned `npm:@tpsdev-ai/pi-flair@<version>`
  entry under `packages` in pi's settings — same idempotence and
  existing-config preservation as the MCP clients. `flair doctor` reports
  wired/not-wired with the pinned version, names the #1346 trap outright (an
  `npm:` spec under `extensions` is silently ignored by pi; `doctor --fix`
  moves it to `packages`), and is explicit about the env boundary: pi-flair
  reads `FLAIR_AGENT_ID`/`FLAIR_URL`/`FLAIR_KEY_PATH` from the shell that
  launches pi, so doctor verifies its own shell and says so rather than
  pretending to see every pi launch. (#1342)
