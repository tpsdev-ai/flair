# Presence Emitter — Deploy Recipe

## Per-agent setup

Copy `scripts/ai.tpsdev.presence-emitter.plist` to `~/Library/LaunchAgents/ai.tpsdev.presence-<agent>.plist`, then replace every occurrence of `AGENTS` with the agent ID, `FLAIR_DIR` with the absolute path to the flair repo (where `scripts/presence-emitter.sh` lives), and `LOG_DIR` with the log directory (e.g. `~/.tps/logs`). Set `FLAIR_REPOS` to the comma-separated list of repos to monitor (default `tpsdev-ai/flair,tpsdev-ai/cli`). The agent's GitHub PAT must be at `~/.tps/secrets/<agent>-github-pat` for `gh-as` to work, and the agent's Flair private key must be discoverable by `flair` (at `~/.flair/keys/<agent>-priv.key` or via `FLAIR_KEY_DIR`). Load with `launchctl load ~/Library/LaunchAgents/ai.tpsdev.presence-<agent>.plist`.
