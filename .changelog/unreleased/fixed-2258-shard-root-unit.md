- **The root unit step runs as deterministic file shards.** The shared unit
  lane's `root unit tests` step ran the whole root unit corpus in one `bun test`
  under a 450 s per-step limit and took 360–441 s on main, so runner variance
  killed it, and the killed step also tripped the temp-dir leak guard. The step is
  now split by file — every file in exactly one shard, checked by the
  `unit-shards.mjs` coverage gate — each shard keeping the 450 s limit and running
  well under half of it. The lane prints each shard's duration, and a step killed
  at the limit is reported once, with the leak-guard result marked not
  attributable.
