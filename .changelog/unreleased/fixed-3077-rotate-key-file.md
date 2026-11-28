- **`flair agent rotate-key` protects the replacement private key with owner-only permissions on POSIX and verifies the stored public key before installation.** The old key is backed up under a new `<agentId>.key.bak.<UTC timestamp>` name; an existing backup is left untouched. ([#3142](https://github.com/tpsdev-ai/flair/pull/3142))

  > **Heads-up:** After an accepted update and failed readback, the current private key may no longer authenticate; the command prints the retained replacement's path.
