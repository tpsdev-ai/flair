/**
 * stale-client-pin.ts — flair#1383
 *
 * `flair doctor` already fails a pin that is not the installed CLI version.
 * That generic staleness line does not say the thing an operator needs:
 * a pre-0.18.0 adapter silently drops writes, including against another
 * agent's shared memories, and upgrading the *server* does not fix it.
 *
 * This helper is the loud, specific finding. Threshold matches
 * `resources/client-version-gate.ts` (`MIN_SAFE_FLAIR_CLIENT`). Duplicated
 * here because the CLI must not import server resources.
 */

import { parseSemverCore, semverGte } from "../fabric-upgrade.js";

export const MIN_SAFE_FLAIR_ADAPTER = "0.18.0";

export const STALE_CLIENT_WRITE_HAZARD =
  "this adapter silently drops writes (including against another agent's shared memories). Upgrade the adapter, not the server";

/** True when `pin` is parseable and strictly older than 0.18.0. */
export function isUnsafeAdapterPin(pin: string | null | undefined): boolean {
  if (!pin) return false;
  if (!parseSemverCore(pin)) return false;
  return !semverGte(pin, MIN_SAFE_FLAIR_ADAPTER);
}

export function unsafeAdapterPinDetail(surface: string, id: string, pin: string): string {
  return `${surface} (${id}): pinned to flair-mcp@${pin} — ${STALE_CLIENT_WRITE_HAZARD}`;
}
