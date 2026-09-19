/**
 * harper-port-value.ts — the ONE parser for a Harper port config value, shared
 * by the CLI (`src/`) and the runtime resources (`resources/`).
 *
 * Moved out of `src/cli.ts` (where it lived as `harperPortValue`), not
 * rewritten: every consumer that interpolates a port into a URL parses it here.
 * A second, hand-rolled parser is the same defect as a second detector — two
 * implementations that can drift, with the drift only visible on the value one
 * of them mishandles.
 *
 * Harper accepts both a bare port (`9926`, all interfaces) and the
 * host-qualified `host:port` form flair writes for the ops API
 * (`127.0.0.1:9925` — see `opsNetworkPortValue`). Both name the same port; only
 * the bind differs, and `detectOpsApiAllInterfacesBind` (lib/ops-api-bind.ts) is
 * what reads the host half. Splits on the LAST colon so an IPv6 literal
 * (`[::1]:9925`) keeps its port.
 *
 * What it checks: ONLY the digits after the last colon. The host half is NOT
 * validated — any host text is accepted and ignored, so a qualified value means
 * "the port is whatever trails the final colon". A value with no colon, an
 * empty string, or a non-numeric tail yields null.
 *
 * Range: a port outside 1..65535 yields null so the caller falls back to its
 * default. `new URL()` rejects a port above 65535, so returning one would hand
 * a URL builder a value that throws instead of a usable loopback URL.
 */
const MAX_TCP_PORT = 65535;

export function harperPortValue(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_TCP_PORT ? value : null;
  }
  const str = String(value).trim();
  if (str === "") return null;
  const lastColon = str.lastIndexOf(":");
  const portPart = lastColon > 0 ? str.slice(lastColon + 1) : str;
  if (!/^\d+$/.test(portPart)) return null;
  const n = Number(portPart);
  return n > 0 && n <= MAX_TCP_PORT ? n : null;
}
