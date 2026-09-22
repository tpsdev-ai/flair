- **The hook writers never lower a pin, repair a continuity command without unpinning it, and decide on every pi source at once.**

  The direct writers that install and repair Flair's harness hooks used to
  rewrite the entry to the running CLI's spec regardless of direction, and the
  continuity capture command was written unpinned unconditionally — so
  repairing a PINNED continuity entry silently UNPINNED it. Each writer now
  consults the same never-lower guard as the client writers
  (`src/lib/pin-write-guard.ts`): an AHEAD pin is held with its bytes untouched
  and the reason named (the entry, the pinned version and the running version);
  a range/tag/unsupported/malformed spec is held exactly as written; a BEHIND
  pin is re-pinned up; an unpinned entry is pinned to the running CLI; and a run
  whose own version cannot be read refuses by name and writes nothing.

  Which mode each path uses, and why:

  - `flair hook install` (SessionStart) and doctor's SessionStart add and legacy
    repair use **pin-to-running-cli** — they write the canonical pinned
    invocation, so an AHEAD entry is held rather than downgraded.
  - the continuity capture pair (doctor's `--fix` and `flair hook
    install --continuity`) uses **continuity-preserve** — a repair keeps the
    entry's OWN pin state, because the continuity command is a capture hook the
    user may have pinned; a fresh (absent) pair is provisioned pinned to the
    running CLI.
  - the removal writers (`uninstallHook`, `uninstallContinuityHooks`,
    doctor's continuity removal) carry no version — they only delete our entries
    and preserve every other byte — so they cannot lower a pin.
  - the pi writer now decides on the `packages` entry AND any misplaced
    `extensions` `npm:` source together (the highest comparable governs, a
    non-comparable one holds), so the #1346 move can no longer drop a pin.

  > **Heads-up (carried from the earlier slice, restated where it bites):** a run
  > whose own version cannot be read refuses to write instead of falling back to
  > the unpinned spec. On a fresh home that also declines a legitimate FIRST
  > install — nothing is created — until the version can be read again.

  (Refs #1778)
