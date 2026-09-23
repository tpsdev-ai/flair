- **A SessionStart hook is now re-pinned only when its full command is one of the exact installer forms; every other shape is held, not rewritten.**

  The hook re-pin validated a command with an unanchored substring match, which
  accepted shapes Flair never wrote and could rewrite the identity the command
  actually used. It now re-pins only when the **full** command equals one of the
  three installer forms (`buildSessionStartHookCommand` output), substituting
  just the pinned version; anything else — a hand-edited command, duplicate
  matching entries, extra shell syntax, an unsupported env var or unsupported
  hook metadata, or the legacy unpinned form — is a visible, byte-preserving
  HOLD. `flair doctor`'s legacy-form rewrite and the hook status display are
  unchanged.

  (Refs #1834)
