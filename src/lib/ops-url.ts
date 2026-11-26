/**
 * ops-url.ts — derive a remote instance's operations API URL from its Flair
 * base URL, the way every remote flair command does (resolveEffectiveOpsUrl in
 * src/cli.ts, which also honours --ops-target / FLAIR_OPS_TARGET). Shared by
 * src/cli.ts and the deploy channel (src/deploy.ts).
 */

/** The default operations API port for a self-hosted instance on plain HTTP with no explicit port. */
export const DEFAULT_OPS_PORT = 19925;
/** The operations API port of a Harper Fabric cluster. */
export const FABRIC_OPS_PORT = 9925;

/** A non-blank endpoint string, or undefined when the option was not set. */
export function explicitEndpoint(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Refusal when `--operations-endpoint` or `--application-endpoint` is set and
 * `--target` is blank. Null when the command may continue. Both `flair deploy`
 * and `flair upgrade` use this; a URL built from org and cluster is not `--target`.
 */
export function endpointFlagsWithoutExplicitTarget(
  command: string,
  opts: { target?: string; operationsEndpoint?: string; applicationEndpoint?: string },
): string | null {
  if (typeof opts.target === "string" && opts.target.trim() !== "") return null;
  if (explicitEndpoint(opts.operationsEndpoint) || explicitEndpoint(opts.applicationEndpoint)) {
    return `${command}: --operations-endpoint and --application-endpoint require --target.`;
  }
  return null;
}

/**
 * Refusal when the application URL's hostname is not the operations URL's
 * hostname. Ports may differ. Null when the hostnames match or either URL
 * cannot be parsed. Admin credentials for version, migration, and fleet reads
 * go to the application URL, so a different host is refused before those reads.
 */
export function endpointHostRefusal(command: string, operationsUrl: string, applicationUrl: string): string | null {
  let opsHost: string;
  let appHost: string;
  try {
    opsHost = new URL(operationsUrl).hostname.toLowerCase();
    appHost = new URL(applicationUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (opsHost === appHost) return null;
  return `${command}: the application endpoint host ${appHost} is not the operations endpoint host ${opsHost}. Refusing to send admin credentials to both hosts.`;
}

/** URL of a fleet sweep: the application endpoint when set, otherwise the fallback (the single target). */
export function applicationProbeUrl(applicationEndpoint: string | undefined, fallback: string): string {
  return explicitEndpoint(applicationEndpoint) ?? fallback;
}

/**
 * Operations API URL for the MQTT-off calls deploy() sends.
 * An explicit ops URL wins, then an explicit operations endpoint, then
 * derivation from the single target URL.
 */
export function resolveDeploymentOpsUrl(
  targetUrl: string,
  opts: { opsUrl?: string; operationsEndpoint?: string },
): string {
  const ops = explicitEndpoint(opts.opsUrl);
  if (ops) return ops.replace(/\/$/, "");
  const operations = explicitEndpoint(opts.operationsEndpoint);
  if (operations) return operations.replace(/\/$/, "");
  return resolveOpsUrlFromTarget(targetUrl);
}

/** Derive the ops API URL from a Flair base URL.
 *  https with effective port 443 (no explicit port, or explicit :443): returns
 *    <host>:9925 (FABRIC_OPS_PORT) — the Fabric managed case where port-1/:442
 *    is a dead-end.
 *  All other cases unchanged:
 *    https with non-443 explicit port → port-1 (self-hosted TLS: 19926→19925, 8443→8442)
 *    http with explicit port → port-1 (19926→19925)
 *    http with no port → DEFAULT_OPS_PORT (19925)
 *  Bare hosts are normalised to https:// (effective-443 → Fabric path).
 *  Throws on unparseable URLs or out-of-range ports.
 */
export function resolveOpsUrlFromTarget(targetUrl: string): string {
  // Normalise bare hosts: add https:// prefix so URL parser can handle them.
  const normalised = targetUrl.includes("://") ? targetUrl : `https://${targetUrl}`;
  const url = new URL(normalised);

  // https target with effective port 443 (no explicit port, or explicit :443):
  // this is the Fabric managed case — the ops API is on the well-known Fabric
  // ops port, never REST-adjacent. The port-1 / :442 logic is a dead-end here.
  if (url.protocol === "https:" && (url.port === "" || url.port === "443")) {
    url.port = String(FABRIC_OPS_PORT);
    return url.toString().replace(/\/$/, "");
  }

  // All other cases: unchanged port-1 convention.
  //   https with non-443 explicit port → port-1 (self-hosted TLS: 19926→19925, 8443→8442)
  //   http with explicit port → port-1 (19926→19925)
  //   http with no port → DEFAULT_OPS_PORT (19925)
  const port = parseInt(url.port, 10);
  if (!isNaN(port) && port > 0 && port <= 65535) {
    const opsPort = port - 1;
    if (opsPort < 1) throw new Error(`Derived ops port ${opsPort} is out of range; target port must be > 1`);
    url.port = String(opsPort);
    return url.toString().replace(/\/$/, "");
  }
  // No valid explicit port — reject port 0 or out-of-range
  if (url.port !== "" && url.port !== undefined) {
    throw new Error(`Invalid target port: ${url.port} (must be 1-65535)`);
  }
  // No explicit port on http — use the default ops port.
  url.port = String(DEFAULT_OPS_PORT);
  return url.toString().replace(/\/$/, "");
}
