- **Integrity custody serializes commits, tombstones and recovery on one lock and writes its intent marker before publishing.**

  An open refuses to publish a staged generation when CURRENT is absent, and
  canonical JSON refuses values it cannot represent (#971).
