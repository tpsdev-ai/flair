- **Every `flair hook` config write is now one locked, identity-checked critical section, so two Flair writers can no longer lose an edit.**

  The hook settings file (`~/.claude/settings.json` / `~/.codex/hooks.json`) is
  read-modify-write, and its writers wrote it back in place with no lock. Two
  writers racing on it — `flair hook install` and `flair hook install
  --continuity`, or two of the five `src/hook-install.ts` writers — both read
  the same bytes and the second write silently discarded the first: a lost
  update, and a path by which a concurrent re-pin could be dropped.

  A new leaf primitive, `src/lib/config-critical-section.ts`
  (`withConfigCriticalSection`), makes observe → decide → write ONE critical
  section: an `O_EXCL` `<resolvedTarget>.lock`, an identity re-check of the
  configured entry, the resolved target and the resolved parent inside the
  lock, the decision taken on the IN-LOCK bytes, and a temp + `fsync` + atomic
  `rename` write. A committed replacement by another writer is HELD and retried
  on a fresh observation (up to three attempts); a retarget, type change,
  parent change or absence change is a final hold naming the changed
  observation. A lock already held REFUSES by name with the recorded holder and
  host — never reclaimed. All five `src/hook-install.ts` writers now go through
  it (the four `src/doctor-client.ts` writers and the client sinks follow).

  > **Heads-up (behaviour change):** config writes now replace the file's inode
  > instead of writing in place, so a client holding an open fd keeps the OLD
  > contents until it reopens (every wired client re-reads at startup); and an
  > owner/group the process cannot preserve is a refusal before the rename, not
  > a silent ownership change.

  > **Heads-up (threat boundary):** this serializes cooperative Flair writers
  > and detects identity changes made before its final check; it does not defend
  > against an ancestor directory replaced between that check and the rename.
  > On NFS/SMB homes `O_EXCL` is unreliable and safety degrades to the in-lock
  > re-observe plus the fresh-attempt protocol; a stale cross-host lock is a
  > named availability refusal.

  (Refs #1778)
