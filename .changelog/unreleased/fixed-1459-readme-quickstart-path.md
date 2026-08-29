- **The README quick start now verifies `flair` is on `PATH` before the first command that needs it** (Refs #1459).
  `npm install -g @tpsdev-ai/flair` puts `flair` in the npm global bin directory,
  which is not on `PATH` when the prefix is a user directory. The quick start
  claimed "one install gives you one command" and then failed at line two with
  `flair: command not found`. It now adds a `flair --version` check right after
  the install, with the one-line remedy inline — `export PATH="$(npm prefix -g)/bin:$PATH"` —
  instead of leaving the trap in the file everyone opens first.
