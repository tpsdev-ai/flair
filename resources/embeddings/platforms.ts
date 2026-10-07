/**
 * Supported node-llama-cpp prebuilts for the flair engine.
 * Exact optionalDependencies in package.json — CPU linux and Metal darwin
 * only. No CUDA, no Vulkan, no umbrella `node-llama-cpp` package.
 *
 * A different installed version is refused before dlopen. The stamp does
 * not carry this version; the loader and provenance do.
 */
export const PINNED_PREBUILT_VERSION = "3.18.1";

export const SUPPORTED_PREBUILTS = [
  { platform: "linux", arch: "x64", packageName: "@node-llama-cpp/linux-x64" },
  { platform: "linux", arch: "arm64", packageName: "@node-llama-cpp/linux-arm64" },
  { platform: "darwin", arch: "arm64", packageName: "@node-llama-cpp/mac-arm64-metal" },
] as const;

export type SupportedPrebuilt = (typeof SUPPORTED_PREBUILTS)[number];

export function prebuiltForPlatform(platform: string, arch: string): SupportedPrebuilt | null {
  for (const entry of SUPPORTED_PREBUILTS) {
    if (entry.platform === platform && entry.arch === arch) return entry;
  }
  return null;
}

export function hostLabel(platform: string, arch: string): string {
  return `${platform}/${arch}`;
}
