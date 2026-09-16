- **Apple Silicon now embeds on Metal by default, and Health says so.**

  When a usable Metal backend is present (darwin-arm64 plus a resolvable
  `@node-llama-cpp/mac-arm64-metal` prebuilt), flair derives `gpuLayers=99`
  and states it on the boot log and `/Health` (`embedding.backend` /
  `gpuLayers` / `source`). Everywhere else the default stays CPU (`0`).
  `FLAIR_EMBED_GPU_LAYERS` still overrides. If offload is requested and
  Metal does not engage, Health and the log state the CPU fallback —
  never a silent CPU run under a GPU claim. (Refs #1437)

  > **Heads-up:** `FLAIR_EMBED_GPU_LAYERS=0` pins CPU on Apple Silicon.
  > Unset now means "derive", not "HFE's 0".
