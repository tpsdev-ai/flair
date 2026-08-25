- **`/Health` no longer reports a node as healthy when search is not actually usable** (flair#1326).
  After restart, Harper can answer `/health` in a few seconds while `/Memory`
  and `/SemanticSearch` are still catch-all 404s, and while the hybrid BM25
  index is still empty (the first search scans the corpus; that lag grows with
  store size). `/Health` now always includes `searchReady`. Missing search
  routes return HTTP 503 and `ok: false`. A live process with a cold index
  stays 200 and names the lag on `searchReadyReason` so a traffic gate can
  tell "up" from "recall-ready." `/HealthDetail` carries the same fields.
