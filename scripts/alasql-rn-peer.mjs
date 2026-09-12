#!/usr/bin/env node
/**
 * alasql-rn-peer.mjs — flair#847.
 *
 * AlaSQL declares `react-native-fs` as an optionalDependency. npm installs
 * those by default, so harper → alasql → react-native-fs → react-native
 * lands in a production tree (~160 MB / 136 packages). optionalDependencies
 * means "do not fail if this cannot be built", not "do not install this".
 *
 * The form npm does not auto-install is an optional peerDependency — the
 * same shape alasql already uses for `react-native-fetch-blob`. Every
 * require('react-native-fs') in alasql sits inside `if (utils.isReactNative)`.
 *
 * This module is the two-field manifest edit. Callers apply it to a packed
 * alasql package.json and to harper's npm-shrinkwrap alasql entry. Repo-root
 * `overrides` are not a substitute: they apply only at the install root and
 * do not reach `npm i @tpsdev-ai/flair` in a clean project.
 */

export const REACT_NATIVE_FS = "react-native-fs";

/**
 * Move react-native-fs from optionalDependencies to an optional peer.
 * Returns whether the manifest changed.
 */
export function promoteReactNativeFsToOptionalPeer(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  const optional = manifest.optionalDependencies;
  if (!optional || typeof optional !== "object" || !Object.prototype.hasOwnProperty.call(optional, REACT_NATIVE_FS)) {
    return false;
  }
  const spec = optional[REACT_NATIVE_FS];
  const rest = { ...optional };
  delete rest[REACT_NATIVE_FS];
  if (Object.keys(rest).length) manifest.optionalDependencies = rest;
  else delete manifest.optionalDependencies;

  manifest.peerDependencies = { ...(manifest.peerDependencies || {}), [REACT_NATIVE_FS]: spec };
  manifest.peerDependenciesMeta = {
    ...(manifest.peerDependenciesMeta || {}),
    [REACT_NATIVE_FS]: { optional: true },
  };
  return true;
}

/** Strip lifecycle scripts that fail when we re-pack a registry tarball (husky, etc.). */
export function stripPackLifecycleScripts(manifest) {
  if (!manifest?.scripts || typeof manifest.scripts !== "object") return false;
  let changed = false;
  for (const name of ["prepack", "prepare", "postpack", "prepublish", "prepublishOnly"]) {
    if (name in manifest.scripts) {
      delete manifest.scripts[name];
      changed = true;
    }
  }
  return changed;
}

/**
 * Patch every lockfile/shrinkwrap package entry that still auto-installs
 * react-native-fs. Harper's shrinkwrap lists the field on alasql but does
 * not lock a react-native-fs node; npm 12 still resolves the field.
 */
export function promoteReactNativeFsInLockfile(lock) {
  if (!lock?.packages || typeof lock.packages !== "object") return 0;
  let n = 0;
  for (const entry of Object.values(lock.packages)) {
    if (promoteReactNativeFsToOptionalPeer(entry)) n++;
  }
  return n;
}
