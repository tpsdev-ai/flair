- **`flair rem restore --apply` lists leftover candidates through the ops API instead of a REST route Harper 405s.**
  `listAgentCandidates` used `POST /MemoryCandidate/search_by_conditions`,
  which Harper's REST dispatcher cannot route — every POST maps to
  `resource.post()`, with no URL-suffix routing — so the candidate cleanup
  step failed with 405. It now uses the injected admin-authed ops-API
  `search_by_conditions` helper, the same ops-root shape `flair rem
  candidates` and the nightly candidate count already use (#860).
