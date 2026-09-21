- **The Metal-default doctor finding is an advisory warning, not a blocking error.**

  `flair doctor` now reads `source` off the Health embedding field. A derived
  (`detected`) Metal default — the operator never chose GPU offload — renders a
  persistent `⚠` and no longer fails the run, while an explicit
  `FLAIR_EMBED_GPU_LAYERS` request (`env`) or an unrecognized/missing source
  stays a blocking `✗` (fail closed). The detected wording is now "Automatic
  Metal acceleration was requested, but engagement could not be verified.":
  the old sentence was a log heuristic, so it can no longer claim the GPU did
  not engage. Genuine semantic failure stays blocking. (Refs #1761)

  > **Heads-up:** on a darwin-arm64 host that never set
  > `FLAIR_EMBED_GPU_LAYERS`, the derived Metal default now shows a persistent
  > warning instead of failing `flair doctor`. Set the variable explicitly if
  > you want an unconfirmed offload to remain a loud, blocking error.
