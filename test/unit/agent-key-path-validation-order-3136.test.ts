/**
 * flair#3136 item 2: each key-path helper applies the shared agent-ID rule
 * before it joins. A Symbol has no string form, so a join that ran first would
 * throw a TypeError instead of the refusal with the shared message.
 */
import { expect, test } from "bun:test";
import { invalidAgentIdMessage } from "../../src/lib/agent-id-rule.js";
import {
  AgentKeyPathRefusal,
  agentKeyPath,
  agentPubKeyPath,
  keyPathIn,
  legacyAgentKeyPath,
} from "../../src/lib/key-dir.js";

const BAD_ID = Symbol("agent") as unknown as string;

const HELPERS: Array<[string, () => string]> = [
  ["agentKeyPath", () => agentKeyPath("/tmp/keys", BAD_ID)],
  ["agentPubKeyPath", () => agentPubKeyPath("/tmp/keys", BAD_ID)],
  ["keyPathIn", () => keyPathIn({ dir: "/tmp/keys", suffix: "-priv.key" }, BAD_ID)],
  ["legacyAgentKeyPath", () => legacyAgentKeyPath(BAD_ID)],
];

for (const [name, call] of HELPERS) {
  test(`${name} refuses before it joins`, () => {
    let caught: unknown;
    try {
      call();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentKeyPathRefusal);
    expect((caught as Error).message).toBe(invalidAgentIdMessage(BAD_ID));
  });
}
