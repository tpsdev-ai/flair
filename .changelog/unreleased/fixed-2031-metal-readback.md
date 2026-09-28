- **Metal engagement is read from the embedding engine, so an empty launchd capture is no longer reported as CPU.**
  For a GPU offload request, `flair status` and `/Health` report three
  states: Metal (with the requested layer count) when the engine says so,
  CPU only when the engine says no GPU, and unconfirmed (not `backend: cpu`,
  not `gpuLayers: 0`) when the engine exposes no readback. A CPU request
  (`FLAIR_EMBED_GPU_LAYERS=0`, or the non-Metal default) is reported as CPU
  without a readback. The GPU type is `getGpuType()` on the native binding
  warmup already opened; a second addon is not loaded for the check. A
  derived Metal default stays an advisory doctor warning.

  > **Heads-up:** an Apple Silicon host that previously showed "Metal did not
  > engage; running CPU" under launchd while ggml was on Metal now follows
  > the engine. If the engine cannot be read, status says engagement is
  > unconfirmed instead of claiming CPU.
