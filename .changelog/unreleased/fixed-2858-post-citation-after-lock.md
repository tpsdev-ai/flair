- **A Memory `POST` records its citations after it releases its per-id locks, as
  `PUT` does.** A POST that supersedes a predecessor and cites it in
  `usedMemoryIds` now credits that predecessor once; before, the POST still held
  the predecessor's lock and the contribution was skipped as busy.
