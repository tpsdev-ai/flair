/**
 * local-instance-pair.ts — the ONE check that an operations API endpoint and an
 * HTTP port belong to one local Flair instance, from that instance's own
 * configuration.
 *
 * Shared by the local delete paths (`memory hygiene --apply`, `agent remove`,
 * via src/lib/local-delete-instance.ts, flair#2225) and by `flair doctor`'s
 * Agent roster and home reads (src/cli.ts `verifyDoctorRosterInstance`,
 * flair#2483), so the rule is written once.
 *
 * What it checks: it asks the loopback ops endpoint on `opsPort` for Harper's
 * `get_configuration`, and accepts only when that configuration
 *   - records a usable `http.port`,
 *   - binds that HTTP port on loopback or on all interfaces (127.0.0.1,
 *     localhost, 0.0.0.0, [::], or a bare port), and
 *   - records `operationsApi.network.port` equal to `opsPort`, the port asked.
 * It then reports the configured HTTP port; the caller compares it with the
 * HTTP port it addresses. A failed request, a non-2xx answer, a body that is
 * not JSON, or any of the three conditions unmet is `unproven`, with a detail
 * naming which.
 *
 * Its limit: `get_configuration` reports the instance's CONFIGURED ports (Harper
 * reads them from its config file). It does not observe which process is
 * listening on a port.
 */
import { harperPortValue } from "./harper-port-value.js";

/** The host halves of an `http.port` binding that bind on loopback or on all interfaces. */
const LOCAL_HTTP_BIND_HOSTS = ["127.0.0.1", "localhost", "0.0.0.0", "[::]", ""];

/** The outcome of {@link proveLocalInstancePair}. */
export type LocalInstancePairProof =
  | { kind: "proven"; httpPort: number }
  | { kind: "unproven"; status: number | null; detail: string };

/**
 * Ask the loopback ops endpoint on `opsPort` for its configuration and decide
 * whether it pairs with a local HTTP port (see the module comment).
 * `authorization` is the full `Authorization` header value. `status` is the
 * HTTP status of a non-2xx answer, else null.
 */
export async function proveLocalInstancePair(
  opsPort: number,
  authorization: string,
): Promise<LocalInstancePairProof> {
  const unproven = (detail: string, status: number | null = null): LocalInstancePairProof =>
    ({ kind: "unproven", status, detail });
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ operation: "get_configuration" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return unproven("the configuration request got no answer");
  }
  if (!response.ok) return unproven(`the configuration request answered HTTP ${response.status}`, response.status);
  let config: any;
  try {
    config = await response.json();
  } catch {
    return unproven("the configuration answer is not JSON");
  }
  const httpPort = harperPortValue(config?.http?.port);
  if (httpPort === null) return unproven("its configuration records no usable HTTP port");
  const configuredOpsPort = harperPortValue(config?.operationsApi?.network?.port);
  if (configuredOpsPort !== opsPort) {
    return unproven(`its configuration records ops port ${configuredOpsPort ?? "none"}, not ${opsPort}`);
  }
  const binding = String(config?.http?.port ?? "");
  const separator = binding.lastIndexOf(":");
  const host = separator < 0 ? "127.0.0.1" : binding.slice(0, separator);
  if (!LOCAL_HTTP_BIND_HOSTS.includes(host)) {
    return unproven(`its configuration binds HTTP to ${host}, not loopback or all interfaces`);
  }
  return { kind: "proven", httpPort };
}
