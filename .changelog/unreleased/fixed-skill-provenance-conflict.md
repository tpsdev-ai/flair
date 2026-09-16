- **Skill registration refuses `/tmp` sources and resolves `SKILL_CONFLICT`.**

  A skill-assignment whose `metadata.source` is a filesystem path under a
  temp directory (`/tmp`, `/private/tmp`, `/var/tmp`, `os.tmpdir()`, and
  `file:` URLs into those) fails at registration and names the path. Two
  assignments of the same skill name at equal priority refuse to load; a
  unique higher priority is stated precedence. A single durable,
  non-conflicting skill still loads silently.

  > **Heads-up:** scratch/inspect paths are no longer recorded as durable
  > skill provenance. Re-register from an npm specifier or a non-temp path.
