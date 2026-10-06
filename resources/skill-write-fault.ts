/**
 * skill-write-fault.ts — the injection point for a per-step fault in the
 * transactional skill writer (flair#2139 S2): successor write, predecessor
 * close, pointer write, version append.
 *
 * The hook is null unless setSkillWriteFaultHook installs one. Nothing under
 * resources/ or src/ calls it; the real-Harper suite installs it from
 * test/fixtures/skill-write-fault-2139/probe.js, which is not in the package.
 */

export type SkillWriteFaultStep = "successor" | "close" | "pointer" | "append";

export type SkillWriteFaultHook = (step: SkillWriteFaultStep, agentId: unknown) => void;

let hook: SkillWriteFaultHook | null = null;

export function setSkillWriteFaultHook(next: SkillWriteFaultHook | null): void {
  hook = next;
}

/** Run the installed hook for `step`; a no-op when none is installed. */
export function maybeThrowSkillWriteFault(step: SkillWriteFaultStep, agentId: unknown): void {
  hook?.(step, agentId);
}
