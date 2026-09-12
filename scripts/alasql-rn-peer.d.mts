/** Types for scripts/alasql-rn-peer.mjs (flair#847). */

export const REACT_NATIVE_FS: "react-native-fs";

export function promoteReactNativeFsToOptionalPeer(manifest: Record<string, unknown>): boolean;
export function stripPackLifecycleScripts(manifest: Record<string, unknown>): boolean;
export function promoteReactNativeFsInLockfile(lock: { packages?: Record<string, Record<string, unknown>> }): number;
