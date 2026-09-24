- **Home resolution follows the platform rule: Windows uses `USERPROFILE`,
  everywhere else `HOME`.**

  `~/.flair/keys` and the MCP client config writers now resolve the home through
  ONE shared `resolveHome()` (`src/lib/home.ts`), called at call time. On Windows
  it prefers `USERPROFILE` — what Node's `os.homedir()` uses — because a
  POSIX-style shell (Git Bash, MSYS, Cygwin) may set `HOME` to a different path;
  preferring `HOME` there moved the key dir away from where the keys actually
  live, so an existing key read as missing. Everywhere else `HOME` stays
  authoritative, so an in-process HOME redirect is still honoured. macOS and
  Linux behaviour is unchanged.

  > **Heads-up:** on Windows, when `HOME` and `USERPROFILE` point to different directories (common under Git Bash, MSYS or Cygwin), Flair now reads and writes MCP client configs under `USERPROFILE`, which is what Node's `os.homedir()` returns, instead of `HOME`. Keys do not move — the keystore already resolved the home with `os.homedir()`, which is `USERPROFILE` on Windows — so existing keys keep working. If an earlier `flair init` wired clients under `HOME`, run `flair doctor --fix` to wire them under `USERPROFILE`.
