- **Home resolution follows the platform rule: Windows uses `USERPROFILE`,
  everywhere else `HOME`.**

  `~/.flair/keys` and the MCP client config writers now resolve the home through
  ONE shared `resolveHome()` (`src/lib/home.ts`), called at call time. On Windows
  it prefers `USERPROFILE` — what Node's `os.homedir()` uses — because a
  POSIX-style shell (Git Bash, MSYS, Cygwin) may set `HOME` to a different path;
  preferring `HOME` there moved the key dir away from where the keys actually
  live, so an existing key read as missing. Everywhere else `HOME` stays
  authoritative, so an in-process HOME redirect is still honoured. Production
  behaviour is unchanged: the home is set before the process starts on every OS.
