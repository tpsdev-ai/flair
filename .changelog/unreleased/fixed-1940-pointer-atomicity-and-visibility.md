- **A pointer commits with its Memory row, a partial PUT keeps a PRIVATE memory private, and an echoed pointer keeps a SHARED pointer shared.**
  The host pointer (`hostSource`) lives in its own `MemoryHostSource` table and is written
  with the request's open transaction, so the Memory row and its pointer commit together or
  not at all — a failed pointer write aborts the whole write instead of leaving a Memory row
  behind. A partial update that omits `visibility` now carries the existing row's visibility
  into the written row, so a private memory cannot be silently made readable. A read-then-PUT
  that echoes the pointer read back keeps the stored pointer and its scope, so a SHARED pointer
  is not narrowed to author-only and its URL's query and fragment are preserved exactly. The
  pointer is also cascaded away when its Memory row is deleted or archived, and an orphan
  sweep removes pointer rows whose Memory is missing or archived.

  (Refs #1940)
