/**
 * mqtt-listener-doctor.ts — the `flair doctor` check that reports when the
 * instance it inspects has an MQTT listener on.
 *
 * Flair runs Harper with MQTT off (src/lib/mqtt-config.ts): its local spawns
 * assert it, and `flair deploy` / `flair upgrade --target` set it on a
 * component deployment and check it after their restart. This check reads the instance's root configuration
 * through the operations API (`get_configuration`) and names each MQTT
 * listener that configuration starts — the TCP and TLS listeners and the
 * WebSocket path — with the change that turns them off. It never changes the
 * configuration.
 *
 * The read answers "not run" when it fails or when the answer is not a
 * recognizable root configuration (rootConfigurationProblem: `{}` or a partial
 * answer), so a doctor that cannot establish the configuration reports the
 * check as NOT RUN and counts it, rather than passing it.
 */
import { MQTT_DISABLED_SET_CONFIGURATION, mqttListenersOn, rootConfigurationProblem } from "./mqtt-config.js";

/** The doctor line when the instance's configuration starts no MQTT listener. */
export const MQTT_LISTENERS_OFF_LINE = "No MQTT listener is configured on this instance (mqtt.network.port, mqtt.network.securePort and mqtt.webSocket are off).";

/** The set_configuration call that turns every MQTT listener off, as an operator would send it. */
export function mqttOffOperation(): string {
  return JSON.stringify({ operation: "set_configuration", ...MQTT_DISABLED_SET_CONFIGURATION });
}

/** The doctor finding for an instance configuration: null when no MQTT listener is on. */
export function describeMqttListenerFinding(config: unknown): { message: string; fixHint: string } | null {
  const listeners = mqttListenersOn(config);
  if (listeners.length === 0) return null;
  return {
    message: `This instance's configuration starts ${listeners.length === 1 ? "an MQTT listener" : `${listeners.length} MQTT listeners`}: ${listeners.join("; ")}. Flair runs Harper with MQTT off.`,
    fixHint:
      `send ${mqttOffOperation()} to the operations API, then restart Harper's worker threads ` +
      "(flair deploy and flair upgrade --target set this for a component deployment and check it after their restart on the node the target URL reaches, failing when they cannot confirm it there and reporting other cluster nodes NOT VERIFIED; flair's local spawns set it on every start).",
  };
}

/** The instance's root configuration, or why it could not be established (the check is then NOT RUN). */
export type InstanceConfigurationRead =
  | { kind: "ok"; config: Record<string, unknown> }
  | { kind: "not-run"; reason: string };

/** Read the instance's root configuration through the operations API. */
export async function readInstanceConfiguration(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InstanceConfigurationRead> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ operation: "get_configuration" }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
  } catch {
    return { kind: "not-run", reason: "the configuration read failed" };
  }
  if (!res.ok) return { kind: "not-run", reason: `the configuration read was answered HTTP ${res.status}` };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { kind: "not-run", reason: "the configuration answer is not JSON" };
  }
  const problem = rootConfigurationProblem(data);
  if (problem) return { kind: "not-run", reason: `the answer is not a recognizable root configuration (${problem})` };
  return { kind: "ok", config: data as Record<string, unknown> };
}

/**
 * The doctor's "MQTT listeners" section for a configuration read: `ok` with
 * the all-off line, `issue` with the listeners on and the fix, or `not-run`
 * with why the configuration could not be established. Doctor counts every
 * status but `ok` as an issue.
 */
export function mqttListenerSection(read: InstanceConfigurationRead): { status: "ok" | "issue" | "not-run"; line: string; fix?: string } {
  if (read.kind === "not-run") {
    return { status: "not-run", line: `MQTT listeners: NOT RUN — ${read.reason}, so the MQTT listener check did not run.` };
  }
  const finding = describeMqttListenerFinding(read.config);
  if (!finding) return { status: "ok", line: MQTT_LISTENERS_OFF_LINE };
  return { status: "issue", line: finding.message, fix: finding.fixHint };
}
