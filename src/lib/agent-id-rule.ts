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

/** The remedy for an id Harper delivered as a JSON integer it could not hold
 *  exactly: it arrives here as a BigInt (or, on another intake, as a number
 *  beyond Number.MAX_SAFE_INTEGER). A BigInt cannot be JSON-stringified, and
 *  an unsafe number has already lost the digits the caller sent, so the
 *  refusal names the remedy instead. */
export const AGENT_ID_STRING_REMEDY = "send the agent id as a string";

/** True for an id Harper delivered from a JSON integer that JavaScript cannot
 *  hold exactly. A BigInt is never an agent ID; an unsafe number would lose
 *  precision when compared or stored, so isValidAgentId refuses it too. */
export function isUnsafeAgentIdWireValue(id: unknown): boolean {
  return typeof id === "bigint" || (typeof id === "number" && !Number.isSafeInteger(id));
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

/** A human-readable refusal message naming the rule and the offending value.
 *  BigInt-safe: `JSON.stringify` throws on a BigInt, so an unsafe wire value
 *  answers the remedy instead of raising inside the refusal. */
export function invalidAgentIdMessage(id: unknown): string {
  if (isUnsafeAgentIdWireValue(id)) return AGENT_ID_STRING_REMEDY;
  let shown: string | undefined;
  try {
    shown = JSON.stringify(id);
  } catch {
    return AGENT_ID_STRING_REMEDY;
  }
  return `invalid agent id ${shown}: an agent id must match ${AGENT_ID_RULE} (1-64 characters: A-Z, a-z, 0-9, _ or -)`;
}
