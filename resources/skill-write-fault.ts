/**
 * skill-write-fault.ts — the injection point for a per-step fault in the
 * transactional skill writer (flair#2139 S2): successor write, predecessor
 * close, pointer write, version append, instruction event.
 *
 * The hook is null unless setSkillWriteFaultHook installs one. Nothing under
 * resources/ or src/ calls it; the real-Harper suite installs it from
 * test/fixtures/skill-write-fault-2139/probe.js, which is not in the package.
 * The optional third argument is the exact row about to be staged, so a test
 * fixture can hand the writer a row its table's validator must refuse
 * (flair#2997); the hook returns void and the writer does not read the row back.
 */

export type SkillWriteFaultStep = "successor" | "close" | "pointer" | "append" | "event";

export type SkillWriteFaultHook = (step: SkillWriteFaultStep, agentId: unknown, record?: Record<string, any>) => void;

let hook: SkillWriteFaultHook | null = null;

export function setSkillWriteFaultHook(next: SkillWriteFaultHook | null): void {
  hook = next;
}

/** Run the installed hook for `step`; a no-op when none is installed. */
export function maybeThrowSkillWriteFault(
  step: SkillWriteFaultStep,
  agentId: unknown,
  record?: Record<string, any>,
): void {
  hook?.(step, agentId, record);
}
