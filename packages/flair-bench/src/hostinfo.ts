/**
 * hostinfo.ts — host fingerprinting.
 *
 * Compute backend + GPU device string come from node-llama-cpp's OWN report
 * (`llama.gpu`, `llama.getGpuDeviceNames()`) — the engine that actually
 * loaded the model, not inferred from `os.platform()`/`os.arch()`. Two
 * hosts can share a platform/arch and still land on different backends
 * (e.g. a Linux x64 box with no CUDA/Vulkan falls back to CPU) — this is
 * what turns shared results into a real model × infra matrix rather than a
 * model × OS-name one.
 */

import os from "node:os";
import type { Llama } from "node-llama-cpp";
import type { ComputeBackend, HostFingerprint } from "./types.js";

const BYTES_PER_GIB = 1024 ** 3;

export async function fingerprintHost(llama: Llama, label?: string): Promise<HostFingerprint> {
  const gpuType = llama.gpu; // "metal" | "cuda" | "vulkan" | false
  const backend: ComputeBackend = gpuType === false ? "cpu" : gpuType;

  let gpuDeviceNames: string[] = [];
  if (backend !== "cpu") {
    try {
      gpuDeviceNames = await llama.getGpuDeviceNames();
    } catch {
      // Some backends/drivers don't expose device enumeration — backend is
      // still known and reported; device names degrade to empty, not a crash.
      gpuDeviceNames = [];
    }
  }

  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || "unknown";

  return {
    label,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel,
    totalRamGiB: os.totalmem() / BYTES_PER_GIB,
    availableRamGiB: os.freemem() / BYTES_PER_GIB,
    backend,
    gpuDeviceNames,
  };
}
