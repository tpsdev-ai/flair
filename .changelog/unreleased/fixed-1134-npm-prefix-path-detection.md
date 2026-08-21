- **install: off-PATH npm prefix is detected and the exact fix printed**
  (flair#1134). `npm i -g` on a user-prefix setup (prefix = `~/.npm-global`)
  succeeds, puts the `flair` bin in `<prefix>/bin`, and then `flair` is
  command-not-found while the docs claim one-command readiness. Three
  surfaces now detect that state, and every message names the actual bin
  directory plus the exact `export PATH="<dir>:$PATH"` line for your shell
  (zsh/bash rc file, `fish_add_path` for fish) — never "check your PATH":
  a `postinstall` warning at install time (delivered via `/dev/tty`, since
  npm ≥ 8 hides lifecycle output on success; measured working on npm 11
  defaults), a TTY-gated one-shot banner when the CLI itself runs (npm ≥ 12
  blocks install scripts by default, so on current npm the CLI is the first
  thing of ours that executes — reached via npx or an absolute path), and a
  `flair doctor` check. The postinstall is read-only, spawn-free, and can
  never fail an install; the boot banner is silent for non-TTY automation
  and skips dev checkouts, npx cache copies, and tar-swap deploys by
  validating that the derived bin dir really holds the flair bin.
