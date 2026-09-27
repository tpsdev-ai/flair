- **Cleanup failures now fail the maintenance response, the transaction helper refuses to run unwrapped, and the pointer failure switch is a test-only adapter replacement.**
  A `MemoryMaintenance` run with any cleanup error returns a failure naming the counts (never
  “Maintenance complete”), and a missing `MemoryHostSource` table is reported rather than silently
  skipped. `withSharedWriteTransaction` throws when Harper’s transaction function is unavailable
  (no unwrapped fallback), skips a CLOSED/detached transaction, and a failed abort is an error. The
  failure-injection seam exists only in test code; a build check scans every file under dist/ for
  it. The real-Harper atomicity/REST-refusal guarantees are asserted by an integration test against
  a composed copy whose pointer adapter is replaced.

  (Refs #1940)
