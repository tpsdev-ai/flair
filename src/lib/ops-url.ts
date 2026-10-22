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
