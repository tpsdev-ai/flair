/**
 * POST /SkillSeed — the `using-flair` installer (flair#2141 S2).
 *
 * Seeds ONE org-wide skill on an instance:
 *   - a skill-tagged Memory row named `using-flair` (persistent, shared), owned
 *     by the reserved system writer, written through Memory's own post/put path
 *     so the SkillScan gate and forced durability apply;
 *   - an org-scope OrgSkillAssignment (skillName `using-flair`, skillRef = the
 *     row's id, priority `standard`) so every agent's bootstrap lists it unless
 *     the agent opts out.
 *
 * Idempotent, and fail-closed: a read of the existing row or assignment that
 * FAILS refuses the seed with a remedy, so a failed read can never be read as
 * "absent" and write a duplicate. The rule itself lives in resources/skill-seed.ts.
 *
 * Auth: operator (verified Harper administrator Basic, or the deliberate
 * internal marker) — the same authority OrgSkillAssignment and AgentSeed take.
 * `flair init` calls this over the operator REST surface.
 */
import { Resource } from "harper";
import { authorizeSoulWrite } from "./soul-write-policy.js";
import { collectionResource, internalContext } from "./in-process.js";
import { Memory } from "./Memory.js";
import { OrgSkillAssignment } from "./OrgSkillAssignment.js";
import {
  USING_FLAIR_SKILL_CONTENT,
  USING_FLAIR_SKILL_NAME,
  USING_FLAIR_SKILL_TRIGGER,
  USING_FLAIR_SHIPPED_HASHES,
} from "./using-flair-skill.js";
import {
  runSkillSeed,
  SEED_SKILL_AGENT_ID,
  SEED_SKILL_ID,
  type SeedAssignment,
  type SeedRowShape,
  type SkillSeedIo,
  type SkillSeedOutcome,
} from "./skill-seed.js";

const ASSIGNMENT_PRIORITY = "standard";

const CURRENT = {
  name: USING_FLAIR_SKILL_NAME,
  content: USING_FLAIR_SKILL_CONTENT,
  hashes: USING_FLAIR_SHIPPED_HASHES,
  priority: ASSIGNMENT_PRIORITY,
};

/** The Memory write body for the seed row. */
function seedSkillBody(): Record<string, unknown> {
  return {
    id: SEED_SKILL_ID,
    agentId: SEED_SKILL_AGENT_ID,
    content: USING_FLAIR_SKILL_CONTENT,
    trigger: USING_FLAIR_SKILL_TRIGGER,
    tags: ["skill"],
    durability: "persistent",
    visibility: "shared",
    metadata: JSON.stringify({ name: USING_FLAIR_SKILL_NAME }),
  };
}

function realIo(): SkillSeedIo {
  return {
    async readRow() {
      try {
        const row = (await (Memory as any).get(SEED_SKILL_ID, internalContext())) as SeedRowShape | null | undefined;
        return { ok: true, row: row ?? null };
      } catch {
        return { ok: false };
      }
    },
    async readAssignments() {
      try {
        const rows: SeedAssignment[] = [];
        for await (const row of (OrgSkillAssignment as any).search(
          { conditions: [{ attribute: "skillName", comparator: "equals", value: USING_FLAIR_SKILL_NAME }] },
          internalContext(),
        )) {
          rows.push(row as SeedAssignment);
        }
        return { ok: true, rows };
      } catch {
        return { ok: false };
      }
    },
    async createRow() {
      const resource = (await collectionResource(Memory, internalContext())) as any;
      await resource.post(seedSkillBody());
    },
    async replaceRow() {
      await (Memory as any).put(seedSkillBody(), internalContext());
    },
    async createAssignment(fields) {
      const resource = (await collectionResource(OrgSkillAssignment, internalContext())) as any;
      const result = await resource.post(fields);
      return (result ?? {}) as SeedAssignment;
    },
  };
}

export class SkillSeed extends Resource {
  allowCreate() {
    return true; // operator-only is enforced in post() via authorizeSoulWrite
  }

  async post(): Promise<Response | SkillSeedOutcome> {
    const ctx = (this as any).getContext?.();
    const { denied } = await authorizeSoulWrite(ctx);
    if (denied) return denied;

    const outcome = await runSkillSeed(realIo(), CURRENT, (message, detail) => console.error(message, detail));
    if (outcome.kind === "refused") {
      return new Response(JSON.stringify({ error: outcome.error, message: outcome.message }), {
        status: outcome.error === "skill_seed_id_conflict" ? 409 : 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return outcome;
  }
}
