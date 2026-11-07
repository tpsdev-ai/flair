/**
 * agent-id-rule.ts — the ONE agent-ID rule, shared by the CLI (src/) and the
 * server (resources/).
 *
 * An agent ID is the key of an Agent row and is used in URLs, shell hooks and
 * federation payloads, so Flair's paths that create an Agent reject ids outside
 * this rule (`flair mcp grant` also applies a narrower naming policy: a leading
 * letter or digit). Before this module the rule lived inline in
 * resources/AgentSeed.ts only: the Agent resource's REST writes,
 * `flair agent add` and the federation merge each accepted an id AgentSeed
 * would have refused, and the JIT-principal writers (XAA / MCP) built an id
 * from a token subject without checking it.
 *
 * This module is deliberately dependency-free (it imports nothing): the
 * resource/CLI boundary guard (test/unit/resource-src-purity-1775.test.ts)
 * requires every src/ module a resources/ file imports to emit no module
 * loads, and src/ must never import harper.
 *
 * The rule: `^[a-zA-Z0-9_-]{1,64}$` — 1..64 characters of A-Z, a-z, 0-9, `_`
 * or `-`.
 */

/** The rule as text, for messages and docs. */
export const AGENT_ID_RULE = "^[a-zA-Z0-9_-]{1,64}$";

/** The maximum length of an agent ID. */
export const AGENT_ID_MAX_LENGTH = 64;

/** The rule as a matcher. */
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The named error the Agent resource's write paths and the federation merge
 *  refuse with. The CLI and JIT-principal writers refuse with the same message
 *  text but not this code. */
export const AGENT_ID_ERROR = "invalid_agent_id";

/** The remedy for an id that cannot be used as a JSON integer: a BigInt, which
 *  cannot be JSON-serialized, or an integral number outside the safe-integer
 *  range, whose value can no longer be trusted to round-trip. */
export const AGENT_ID_STRING_REMEDY = "send the agent id as a string";

/** True for an id Harper delivered from a JSON integer whose value JavaScript
 *  cannot trust to round-trip. A BigInt is never an agent ID; an unsafe number
 *  cannot be trusted when compared or stored, so isValidAgentId refuses it
 *  too. */
export function isUnsafeAgentIdWireValue(id: unknown): boolean {
  return (
    typeof id === "bigint" ||
    (typeof id === "number" && Number.isInteger(id) && !Number.isSafeInteger(id))
  );
}

/**
 * Is `id` an agent ID this rule accepts? A non-string, non-number value —
 * including `null` — is never valid. A write path must distinguish an OMITTED
 * id (nothing to check; Harper may generate one) from a SUPPLIED `null`, which
 * this returns false for.
 */
export function isValidAgentId(id: unknown): boolean {
  if (typeof id !== "string" && typeof id !== "number") return false;
  if (typeof id === "number" && !Number.isSafeInteger(id)) return false;
  return AGENT_ID_PATTERN.test(String(id));
}

/** A human-readable refusal. A BigInt or an unsafe integer gets the string
 *  remedy alone (no rule). Every other value gets
 *  "invalid agent id <shown>: <rule>", where a Symbol or a non-finite number
 *  is shown as String(id) and anything else as JSON.stringify(id); after
 *  those branches, a JSON.stringify call that throws or returns undefined
 *  produces "invalid agent id (<type> that cannot be serialized): <rule>"
 *  instead. */
export function invalidAgentIdMessage(id: unknown): string {
  if (isUnsafeAgentIdWireValue(id)) return AGENT_ID_STRING_REMEDY;
  const rule = `an agent id must match ${AGENT_ID_RULE} (1-64 characters: A-Z, a-z, 0-9, _ or -)`;
  let shown: string | undefined;
  if (typeof id === "symbol" || (typeof id === "number" && !Number.isFinite(id))) {
    shown = String(id);
  } else {
    try {
      shown = JSON.stringify(id);
    } catch {
      // JSON.stringify cannot represent this value; report it by type below.
    }
  }
  if (shown === undefined) {
    const type =
      id === undefined ? "undefined" : typeof id === "object" ? "an object" : `a ${typeof id}`;
    return `invalid agent id (${type} that cannot be serialized): ${rule}`;
  }
  return `invalid agent id ${shown}: ${rule}`;
}
