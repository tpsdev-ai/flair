// skill-write-fault-2139 — TEST-ONLY resource for flair#2139 S2's per-step
// failure-injection cases (test/integration/skill-version-completion-2139.test.ts)
// and flair#2997's invalid-server-row cases
// (test/integration/server-row-validation-status-2997.test.ts).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as dist/resources/zz-skill-write-fault-2139.js.
// Nothing under resources/ references it and it is never packed or shipped.
//
// It installs the skill writer's fault hook:
//   - a write owned by `__flair_fault_test__<step>` throws at that step;
//   - a write owned by `__flair_fault_mutate__<step>` hands the row about to be
//     staged an invalid value, so the writer's table validator must refuse it.
import { setSkillWriteFaultHook } from "./skill-write-fault.js";

const PREFIX = "__flair_fault_test__";
const MUTATE_PREFIX = "__flair_fault_mutate__";

setSkillWriteFaultHook((step, agentId, record) => {
  if (agentId === `${PREFIX}${step}`) throw new Error(`skill-write fault injected at '${step}' (test-only)`);
  if (!record || agentId !== `${MUTATE_PREFIX}${step}`) return;
  if (step === "successor") record.content = 123;
  else if (step === "append") record.guarded = "no";
  else if (step === "event") record.summary = 123;
});
