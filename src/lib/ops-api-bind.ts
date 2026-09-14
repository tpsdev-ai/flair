/**
 * ops-api-bind.ts — one decision for "is the Harper ops API bound to all
 * interfaces?", shared by `flair doctor` and `flair status` (flair#670,
 * unified in flair#852).
 *
 * The Harper ops API used to bind all interfaces unconditionally. `flair init`
 * now defaults it to loopback + the domain socket, with an escape hatch
 * (`--ops-bind` / `FLAIR_OPS_BIND`) for deployments that genuinely need remote
 * ops access (flair#670). That narrowing is only useful if every health surface
 * agrees on what the running install actually bound, and it is what doctor
 * reads out of Harper's own config: a bare numeric port is Harper's
 * all-interfaces default; a `host:port` string means something already narrowed
 * the bind.
 *
 * flair#852 was the two surfaces disagreeing. `flair doctor` flagged the bare
 * port while `flair status` printed "✓ all checks passing" — a security-relevant
 * exposure visible to one command and invisible to the other, so users shipped
 * with the ops API reachable off-box. The fix is structural: the decision lives
 * HERE, both commands call it, and status folds the finding into the same
 * warning verdict that drives its green line.
 *
 * Pure: parsing Harper's config is the caller's job (doctor/status both read it
 * with `readHarperConfig`); this module only decides.
 */

export interface OpsApiAllInterfacesDetect {
  /** True for a bare port (Harper's all-interfaces default). */
  allInterfaces: boolean;
  /** The host half when the bind was narrowed, e.g. "127.0.0.1"; null otherwise. */
  boundHost: string | null;
}

/**
 * Decide whether a persisted `operationsApi.network.port` value (read back from
 * harper-config.yaml) indicates an all-interfaces ops-API bind.
 *
 * A bare port number/numeric string is Harper's all-interfaces default (the
 * pre-flair#670 behavior, or an install that predates the fix and has not been
 * re-`init`ed). A "host:port" string means something upstream — a `flair init`
 * since #670, or manual config — already narrowed the bind. Splits on the LAST
 * colon so an IPv6 literal (`[::1]:19925`) keeps its port.
 */
export function detectOpsApiAllInterfacesBind(
  portValue: unknown,
): OpsApiAllInterfacesDetect {
  if (portValue === undefined || portValue === null) return { allInterfaces: false, boundHost: null };
  const str = String(portValue).trim();
  if (str === "") return { allInterfaces: false, boundHost: null };
  const lastColon = str.lastIndexOf(":");
  if (lastColon > 0) {
    return { allInterfaces: false, boundHost: str.slice(0, lastColon).replace(/[[\]]/g, "") };
  }
  return { allInterfaces: true, boundHost: null };
}

export interface OpsApiBindFinding {
  /** True when the ops API is bound to all interfaces. */
  allInterfaces: boolean;
  /** The raw `operationsApi.network.port` value as read from Harper's config. */
  portValue: unknown;
  /** The narrowed host when there is one; null for all-interfaces. */
  boundHost: string | null;
  /** One-line summary, identical in every surface that renders it. */
  message: string;
  /** The single prescribed remedy — the same words everywhere. */
  remedy: string;
}

const OPS_API_BIND_REMEDY =
  "Single-host installs don't need this reachable off-box. Fix: flair init && flair restart " +
  "(rebinds to loopback + domain socket; re-init reuses your existing admin password, so this is " +
  "safe on a running install — pass --ops-bind for deliberate remote admin)";

/**
 * The ops-API bind finding for a parsed harper-config, or null when the config
 * declares no ops port (nothing to report). This is the single source of truth
 * `flair doctor` and `flair status` both call, so they cannot disagree about
 * the same instance.
 */
export function opsApiBindFinding(
  harperConfig: Record<string, any> | null | undefined,
): OpsApiBindFinding | null {
  const portValue = harperConfig?.operationsApi?.network?.port;
  if (portValue === undefined || portValue === null || String(portValue).trim() === "") return null;
  const { allInterfaces, boundHost } = detectOpsApiAllInterfacesBind(portValue);
  return {
    allInterfaces,
    portValue,
    boundHost,
    message: `Ops API bound to all interfaces (${String(portValue)})`,
    remedy: OPS_API_BIND_REMEDY,
  };
}
