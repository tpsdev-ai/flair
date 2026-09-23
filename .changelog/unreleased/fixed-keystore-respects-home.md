- **The keystore now resolves the home from HOME at call time, not a value cached at process start.**

  `~/.flair/keys` (the Ed25519 keystore) previously joined `os.homedir()`, which
  the runtime caches before any application code runs. A HOME set later in the
  same process was ignored, so the keystore could read or write keys under a
  home other than the one the rest of the process was using. It now prefers
  HOME/USERPROFILE and falls back to `os.homedir()`, the same convention
  `install/clients.ts` already uses. Production behaviour is unchanged: HOME is
  set before the process starts on every OS.
