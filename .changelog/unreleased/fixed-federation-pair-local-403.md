- **`flair federation pair` names a local `/FederationInstance` 403 instead of dumping raw AccessViolation.**

  Pair's first step is a signed GET of the local instance identity
  (`allowAdmin`). A 403 now throws `FederationPairLocalAccessError` naming
  the LOCAL side, the missing admin role/grant, `FLAIR_ADMIN_AGENTS` /
  `flair principal add <id> --admin`, and the hub pairing-role restore
  (`flair init --remote` → `flair_pair_initiator`). Only a true
  AccessViolation is rewritten; a hub POST is named as a missing pairing
  role only when the body says so. Refs #820.

  > **Heads-up:** a 403 on pair is usually the local identity read, not the
  > hub. Check `FLAIR_ADMIN_AGENTS` in the *server* process env, or
  > `flair principal add <id> --admin`, before chasing hub tokens.
