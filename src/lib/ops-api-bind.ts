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
 * reads out of Harper's own config. The predicate is an allow-list: ONLY a
 * loopback host narrows the bind. A bare numeric port, a wildcard host
 * (`0.0.0.0:19925`, `[::]:19925`, …), an empty/unspecified host and an
 * unparseable value are all reported as exposed — a `host:port` string is not
 * evidence of narrowing unless the host is actually loopback.
 *
 * That allow-list is the flair#852 wildcard blind spot. The detector originally
 * treated ANY `host:port` as narrowed, so `flair init --ops-bind 0.0.0.0`
 * persisted `0.0.0.0:19925` and both `flair status` and `flair doctor` printed
 * green while the ops API was reachable off-box.
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
  /** True unless the bind is narrowed to loopback. */
  allInterfaces: boolean;
  /** The loopback host the bind was narrowed to, e.g. "127.0.0.1"; null otherwise. */
  boundHost: string | null;
}

/**
 * Hosts that genuinely narrow the ops-API bind to loopback. This is an
 * allow-list on purpose: ANYTHING not in it — a wildcard (`0.0.0.0`, `::`,
 * `[::]`, `0:0:0:0:0:0:0:0`), an explicit routable host, an empty/unspecified
 * host, or a value we cannot parse — is reported as exposed. The cost of a
 * missed exposure (a user ships an ops API reachable off-box) is worse than the
 * cost of warning about a bind we did not recognise.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Best-effort host half of a persisted `operationsApi.network.port` value.
 * Returns null when the value declares no host (a bare port) or the host is
 * unparseable; the caller reports both as exposed.
 *
 * Handles the forms flair and Harper write:
 *   - `127.0.0.1:19925`  → `127.0.0.1`
 *   - `[::1]:19925`      → `::1`   (bracketed IPv6, port stripped)
 *   - `[::]:19925`       → `::`
 *   - `::1:19925`        → `::1`   (bare IPv6 with a trailing numeric port)
 *   - `::`               → `::`    (bare wildcard, nothing to strip)
 *   - `0:0:0:0:0:0:0:0`  → `0:0:0:0:0:0:0` (still not loopback — flagged)
 *
 * Splits on the LAST colon so an IPv6 literal keeps its port, matching
 * `harperPortValue`. A trailing all-digit segment is treated as the port; a
 * bare IPv6 like `::` has no trailing port, so the whole value is the host.
 */
function parseBindHost(str: string): string | null {
  if (str.startsWith("[")) {
    const close = str.indexOf("]");
    if (close === -1) return null; // malformed bracket form — unparseable
    return str.slice(1, close);
  }
  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) return null; // bare port — no host to narrow on
  const tail = str.slice(lastColon + 1);
  return /^\d+$/.test(tail) ? str.slice(0, lastColon) : str;
}

/**
 * Decide whether a persisted `operationsApi.network.port` value (read back from
 * harper-config.yaml) indicates an ops-API bind reachable off-box.
 *
 * A bare port number/numeric string is Harper's all-interfaces default (the
 * pre-flair#670 behavior, or an install that predates the fix and has not been
 * re-`init`ed). A `host:port` string narrows the bind ONLY when the host is
 * loopback — a wildcard (`0.0.0.0:19925`, `[::]:19925`, `::19925`) is still
 * all-interfaces, and is flagged (flair#852). Empty/unspecified and unparseable
 * values are flagged too.
 */
export function detectOpsApiAllInterfacesBind(
  portValue: unknown,
): OpsApiAllInterfacesDetect {
  if (portValue === undefined || portValue === null) return { allInterfaces: false, boundHost: null };
  const str = String(portValue).trim();
  if (str === "") return { allInterfaces: false, boundHost: null };
  const host = parseBindHost(str);
  if (host !== null && LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return { allInterfaces: false, boundHost: host };
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
