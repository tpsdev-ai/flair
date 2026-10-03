/**
 * skill-write-fault.ts — the TEST-ONLY per-step fault hook for the transactional
 * skill writer (flair#2139 S2). It exists so a real-Harper suite can prove that a
 * failure at any one step of a skill write (successor write, predecessor close,
 * pointer write, version append) aborts the WHOLE transaction: no successor row,
 * no predecessor close, no version row.
 *
 * Gated so it can never fire in production — TWO exact-match conditions, both
 * required (the belt-and-suspenders shape resources/migrations/
 * synthetic-test-migration.ts already uses):
 *
 *   1. `FLAIR_ENABLE_TEST_SKILL_WRITE_FAULT` must EXACTLY equal `"1"`. This is a
 *      deliberate, exact-match opt-in, never a generic NODE_ENV=test check.
 *      Production flair never sets it (nothing in src/ or the launchd templates
 *      does).
 *   2. The write's subject owner id must start with the reserved prefix
 *      `__flair_fault_test__` followed by the step name being injected
 *      (`successor` | `close` | `pointer` | `append`). No production agent id
 *      carries that prefix, so no production write is ever a fault candidate.
 *
 * Both are read here, at the point of injection — not at import — so even a
 * production process that somehow had the env var set would still not fault any
 * real write. A unit test pins both conditions against arbitrary envs.
 */

export type SkillWriteFaultStep = "successor" | "close" | "pointer" | "append";

/** The exact-match env var that arms the hook (`"1"`). */
export const ENABLE_TEST_FAULTS_ENV = "FLAIR_ENABLE_TEST_SKILL_WRITE_FAULT";

/** The reserved agent-id prefix a faulted write's owner must carry. */
export const TEST_FAULT_AGENT_PREFIX = "__flair_fault_test__";

const STEPS: ReadonlySet<string> = new Set<SkillWriteFaultStep>(["successor", "close", "pointer", "append"]);

/** The step encoded in a reserved test agent id, or null for any other id. */
export function faultStepOfAgent(agentId: unknown): SkillWriteFaultStep | null {
  if (typeof agentId !== "string" || !agentId.startsWith(TEST_FAULT_AGENT_PREFIX)) return null;
  const suffix = agentId.slice(TEST_FAULT_AGENT_PREFIX.length);
  return STEPS.has(suffix) ? (suffix as SkillWriteFaultStep) : null;
}

/** Whether the test-only fault for `step` is armed for a write owned by `agentId`. */
export function skillWriteFaultArmed(
  step: SkillWriteFaultStep,
  agentId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ENABLE_TEST_FAULTS_ENV] === "1" && faultStepOfAgent(agentId) === step;
}

/** Throw when the test-only fault for `step` is armed; a no-op otherwise. */
export function maybeThrowSkillWriteFault(
  step: SkillWriteFaultStep,
  agentId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (skillWriteFaultArmed(step, agentId, env)) {
    throw new Error(`skill-write fault injected at '${step}' (test-only)`);
  }
}
