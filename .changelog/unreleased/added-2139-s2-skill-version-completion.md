- **Retained skill payloads, `_reindex`, the seed lineage and org skill
  references now honour slice 2's history rules.**

  The transactional skill writer gains a per-step fault hook that is empty
  unless a test-only fixture outside the package installs it, so the real-Harper
  suite can prove a failure at the successor write, predecessor close, pointer
  write or version append rolls the whole write back.

  > **Heads-up:** an update that tightens a skill to private now also revokes
  > read access to its predecessor's retained payload through Memory GET/search
  > and the Feed replay, not only through the version read.
