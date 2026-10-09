- **`POST /MemoryArchive` answers a refused basement or restore with the refusal's own HTTP status and named error, not HTTP 200.**
  A caller the underlying `Memory.put` refuses (403) — or any other non-2xx — now sees that status and the error it names; a successful basement/restore keeps its success response.
