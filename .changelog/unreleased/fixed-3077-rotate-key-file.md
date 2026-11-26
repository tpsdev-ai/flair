- **`flair agent rotate-key` stages the replacement private key owner-only on POSIX, then renames it into place once Flair holds its public key.** The old key is backed up under a new `<agentId>.key.bak.<UTC timestamp>` name; an existing backup is left untouched.

> **Heads-up:** After an accepted update and failed readback, the current private key may no longer authenticate; the command prints the retained replacement's path.
