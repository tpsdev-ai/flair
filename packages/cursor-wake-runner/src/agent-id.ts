/**
 * Deterministic Cursor Cloud Agent id from an OrgEvent id.
 *
 * Cursor's POST /v1/agents accepts a client-supplied `agentId` of the form
 * `bc-<uuid>`. Re-POSTing the same id returns `409 agent_id_conflict` instead
 * of creating a second agent. That is the single-launch guarantee for
 * at-least-once OrgEvent redelivery (flair#1613).
 *
 * The uuid is SHA-256 name-based (version 8), not random and not SHA-1.
 */

import { DNS_NAMESPACE, uuidFromSha256 } from "./uuid.js";

/** Namespace for wake-runner agent ids — not a raw event-id hash. */
export const WAKE_NAMESPACE = uuidFromSha256("flair.cursor.wake", DNS_NAMESPACE);

const BC_UUID =
  /^bc-[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function wakeAgentId(eventId: string): string {
  if (!eventId) throw new Error("wakeAgentId requires a non-empty OrgEvent id");
  return `bc-${uuidFromSha256(eventId, WAKE_NAMESPACE)}`;
}

export function isWakeAgentId(value: string): boolean {
  return BC_UUID.test(value);
}
