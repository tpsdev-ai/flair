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
 * The read returns null when it fails (never an empty configuration), so a
 * doctor that cannot read the configuration reports the check as not run
 * rather than passed.
 */
import { MQTT_DISABLED_SET_CONFIGURATION, mqttListenersOn } from "./mqtt-config.js";

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
      "(flair deploy and flair upgrade --target set this and check it after their restart for a component deployment, failing when they cannot confirm it; flair's local spawns set it on every start).",
  };
}

/** Read the instance's root configuration through the operations API; null when the read fails. */
export async function readInstanceConfiguration(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Record<string, unknown> | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(args.opsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.authHeader },
      body: JSON.stringify({ operation: "get_configuration" }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
