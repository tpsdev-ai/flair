- **`GET /Presence` now requires a verified reader by default; the public roster
  is an explicit opt-in.** An anonymous caller gets 401, not a redacted roster.

  On an internet-exposed instance the roster was a who-is-working-when feed:
  names, roles, activity class and last-alive time of every member, to anyone.
  It is org-visible data, not public data, so the default now requires a valid
  `TPS-Ed25519` agent signature from a registered agent, or the admin
  credential. Set `PRESENCE_PUBLIC_ROSTER=true` to restore the previous
  anonymous, field-allowlisted roster — it publishes your roster to the
  internet. The allowlist and the `currentTask`/version content gate are
  unchanged for verified readers.

  > **Heads-up:** an instance that relied on the public roster (for example a
  > status page) must set `PRESENCE_PUBLIC_ROSTER=true` on the Flair process.

  (Closes #1880)
