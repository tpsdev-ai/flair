/**
 * stabilize-mqtt-network.ts — keep mqtt.network key order settled (flair#1586 / #1581).
 *
 * Harper's HARPER_SET_CONFIG persist (`applyRuntimeEnvVarConfig`) does
 * `YAML.stringify` of the in-memory object, so map key order is insertion
 * order. First repair on a default/populate yaml writes:
 *
 *   mqtt.network: port, securePort, mtls
 *
 * A later direct spawn that omits SET_CONFIG (production `buildDirectSpawnEnv`)
 * runs `cleanupRemovedEnvVar`. When SET_CONFIG first saw those ports as
 * already-null it stored no originals, so cleanup DELETES `port` / `securePort`
 * and the MQTT_* env vars re-add them after the surviving `mtls` key:
 *
 *   mqtt.network: mtls, port, securePort
 *
 * Adopt SET_CONFIG then `setNestedValue`s in place and keeps that order.
 * `#1581` requires harper-config.yaml to be byte-identical across
 * `doctor --fix`, so the adopt persist fails even though every value matches.
 *
 * This helper rewrites only the `mqtt.network` scalar lines, in the file's
 * own indent/quoting, to the first-repair order. Fail-closed: nested maps,
 * comments inside the map, or a shape we cannot attribute are left untouched
 * rather than dumping the whole document (a full dump would fail #1581 on
 * its own).
 */

import { load as parseYaml } from "js-yaml";

const PREFERRED_MQTT_NETWORK_KEYS = ["port", "securePort", "mtls"] as const;

export function stabilizeMqttNetworkKeyOrder(text: string): { text: string; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { text, changed: false };
  }
  const net =
    parsed && typeof parsed === "object"
      ? (parsed as { mqtt?: { network?: unknown } }).mqtt?.network
      : undefined;
  if (!net || typeof net !== "object" || Array.isArray(net)) {
    return { text, changed: false };
  }

  const keys = Object.keys(net);
  const preferred = PREFERRED_MQTT_NETWORK_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(net, k));
  const rest = keys.filter((k) => !preferred.includes(k as (typeof PREFERRED_MQTT_NETWORK_KEYS)[number]));
  const wanted = [...preferred, ...rest];
  if (wanted.length === 0 || keys.every((k, i) => k === wanted[i])) {
    return { text, changed: false };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const endsWithEol = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

  let mqttIdx = -1;
  let mqttIndent = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)mqtt:\s*$/);
    if (m) {
      mqttIdx = i;
      mqttIndent = m[1];
      break;
    }
  }
  if (mqttIdx < 0) return { text, changed: false };

  let netIdx = -1;
  let netIndent = "";
  for (let i = mqttIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = lines[i].match(/^[ \t]*/)?.[0] ?? "";
    if (indent.length <= mqttIndent.length) break;
    const m = lines[i].match(/^([ \t]*)network:\s*$/);
    if (m) {
      netIdx = i;
      netIndent = m[1];
      break;
    }
  }
  if (netIdx < 0) return { text, changed: false };

  const items: { key: string; line: string }[] = [];
  let bodyEnd = netIdx + 1;
  for (let i = netIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") return { text, changed: false };
    if (trimmed.startsWith("#")) return { text, changed: false };
    const indent = lines[i].match(/^[ \t]*/)?.[0] ?? "";
    if (indent.length <= netIndent.length) {
      bodyEnd = i;
      break;
    }
    const keyMatch = lines[i].match(/^[ \t]+([^:#\s]+):\s*/);
    if (!keyMatch) return { text, changed: false };
    const next = lines[i + 1];
    if (next) {
      const nextTrim = next.trim();
      if (nextTrim !== "" && !nextTrim.startsWith("#")) {
        const nextIndent = next.match(/^[ \t]*/)?.[0] ?? "";
        if (nextIndent.length > indent.length) return { text, changed: false };
      }
    }
    items.push({ key: keyMatch[1], line: lines[i] });
    bodyEnd = i + 1;
  }
  if (items.length === 0) return { text, changed: false };

  const fileKeys = items.map((it) => it.key);
  if (fileKeys.length !== wanted.length || wanted.some((k) => !fileKeys.includes(k))) {
    return { text, changed: false };
  }
  if (fileKeys.every((k, i) => k === wanted[i])) return { text, changed: false };

  const byKey = new Map(items.map((it) => [it.key, it.line]));
  const newBody = wanted.map((k) => byKey.get(k)!);
  const newLines = [...lines.slice(0, netIdx + 1), ...newBody, ...lines.slice(bodyEnd)];
  return { text: newLines.join(eol) + (endsWithEol ? eol : ""), changed: true };
}
