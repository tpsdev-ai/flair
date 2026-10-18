import { AGENT_ID_ERROR, invalidAgentIdMessage, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { randomUUID } from "node:crypto";
/**
 * POST /AgentSeed
 *
 * Auto-seeds a new agent with soul entries and starter memories.
 * The CLI provisions Agents through the operations API, not this endpoint.
 *
 * Request:
 *   agentId          string   — agent identifier
 *   displayName      string?  — human-readable name (defaults to agentId)
 *   role             string?  — "admin" | "agent" (default: "agent")
 *   soulTemplate     object?  — key:value pairs for Soul table (merged with defaults)
 *   starterMemories  array?   — [{content, tags?, durability?}] (defaults if omitted)
 *
 * Response:
 *   { agent, soulEntries, memories, created, alreadyExisted, soulCreated, soulAlreadyExisted }
 *
 * `agent` and every `soulEntries` element are read back from the committed
 * store. For attempted creates, `created` / `soulCreated` mean the stored row
 * matches every field of this seed's staged row, including generated timestamps
 * and Soul provenance. Otherwise, including an independent concurrent seed with
 * the same input but different generated fields, or an entry found before staging,
 * `alreadyExisted` / `soulAlreadyExisted` apply; the response does not claim a
 * write that may not have landed.
 *
 * Auth: operator (verified Harper administrator Basic) or deliberate
 * `internalContext()`. Admin-agent Ed25519 keys are refused — role is not
 * source. Intended: provisioning a principal and its Soul is a trust-root act.
 */

import { Resource, databases } from "harper";
import { allowAdmin, invalidateAdminCache } from "./agent-auth.js";
import { authorizeSoulWrite, refuseSoulWriteContent, soulProvenance } from "./soul-write-policy.js";
import { reconcileAdminFields } from "./agent-admin.js";
import { noteMemoryUpsert } from "./bm25-index-service.js";
import { stripUndeclaredMemoryAttributes, stripServerStampedFields } from "./memory-declared-attributes.js";
import { rejectSkillWritePath } from "./skill-write.js";
import { stampEphemeralExpiry } from "./memory-durability.js";
import { stampOriginatorOnCreate } from "./originator-instance.js";
import { SKILL_ASSIGNMENT_KEY } from "./skill-provenance.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";

const DEFAULT_SOUL_KEYS = (agentId: string, displayName: string, role: string, now: string) => ({
  name: displayName,
  role,
  created: now,
  status: "active",
});

const DEFAULT_MEMORIES = (agentId: string, now: string) => [
  {
    content: `Agent ${agentId} initialized. No prior context.`,
    tags: ["onboarding", "system"],
    durability: "persistent",
  },
];

function isStoredRow(value: unknown, id: string, fields: string[]): value is Record<string, any> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const row = value as Record<string, unknown>;
  return Object.hasOwn(row, "id") && row.id === id && fields.every(
    (field) => Object.hasOwn(row, field) && typeof row[field] === "string",
  );
}

function sameSeededAgent(stored: Record<string, any>, seeded: Record<string, any>): boolean {
  return Object.keys(seeded).every(
    (field) => stored[field] === seeded[field],
  );
}

function sameSeededSoul(stored: Record<string, any>, seeded: Record<string, any>): boolean {
  return Object.keys(seeded).every(
    (field) => stored[field] === seeded[field],
  );
}

export class AgentSeed extends Resource {
  // Admin-only: permit verified ADMIN agents (Basic-admin is super_user and
  // bypasses allow*); non-admin agents denied. Real authorization now that the
  // gate no longer elevates agents to admin.
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(data: any) {
    // Harper v5 does not populate this.request on Resource subclasses —
    // getContext() is the only reliable path (the previous
    // `(this as any).request` read was always undefined, so actorId was always
    // undefined and this belt-and-suspenders check fail-closed every request,
    // even from a real admin already verified by allowCreate()).
    const ctx = (this as any).getContext?.();
    const { auth, source, denied } = await authorizeSoulWrite(ctx);
    if (denied) return denied;

    const { agentId, displayName, role = "agent", soulTemplate, starterMemories } = data || {};
    // flair#2359 — the ONE shared agent-ID rule, which refuses an absent id
    // (`undefined`/`null`/empty) exactly as it refuses a malformed one.
    if (!isValidAgentId(agentId)) {
      return new Response(
        JSON.stringify({ error: AGENT_ID_ERROR, message: invalidAgentIdMessage(agentId) }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const now = new Date().toISOString();
    const name = displayName || agentId;

    // Validate the entire caller-controlled template before creating any rows.
    const defaults = DEFAULT_SOUL_KEYS(agentId, name, role, now);
    const merged = { ...defaults, ...(soulTemplate || {}) };
    // flair#2141 S1: a seeded Soul entry carries a value only, so a
    // skill-assignment (and its optOut metadata) is written through Soul.
    if (Object.hasOwn(merged, SKILL_ASSIGNMENT_KEY)) {
      return new Response(JSON.stringify({
        error: "skill_assignment_not_seedable",
        message: "soulTemplate cannot carry a skill-assignment; write it through Soul",
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    for (const value of Object.values(merged)) {
      const refusal = await refuseSoulWriteContent({ agentId, value: String(value) });
      if (refusal) return refusal;
    }

    // The seed's writes run in a transaction this call owns, so it can read the
    // committed store after that transaction commits (flair#2645, AgentSeed).
    let agentWritten = false;
    const outcome = await withOwnedTransaction(ctx, async (c: unknown) => {
      // ── Agent record ────────────────────────────────────────────────────────
      // flair#1965 r3: a FAILED existing-Agent lookup must refuse the whole seed.
      // The previous `.catch(() => null)` turned a read ERROR into "no agent", so
      // the raw Agent.put below would take the CREATE branch and overwrite an
      // existing row (with a fresh local originator stamp). A read error is never
      // "no row". See resources/originator-instance.ts for the same rule on the
      // resource write paths.
      let existingAgent: any;
      try {
        existingAgent = await (databases as any).flair.Agent.get(agentId, c);
      } catch (err) {
        // Constant format string + a structured data object (semgrep
        // javascript.lang.security.audit.unsafe-formatstring).
        console.error(
          "AgentSeed: the existing-agent lookup failed, so the seed was refused rather than overwriting the row as a create",
          { agentId, err },
        );
        return new Response(JSON.stringify({
          error: "agent_lookup_failed",
          message: "the existing agent record could not be read, so the seed was refused",
        }), { status: 500, headers: { "content-type": "application/json" } });
      }
      let agent = existingAgent;
      if (!existingAgent) {
        // flair#941 — this writes the RAW table, so resources/Agent.ts's post()
        // never runs and its field reconciliation does not apply here. Seeding
        // role:"admin" without the mirror was the one path in the product that
        // produced a genuine administrator every reporter displayed as an
        // ordinary agent. Admin-only path (allowCreate + the isAdmin re-check
        // above), so this normalises an authorized intent.
        agent = reconcileAdminFields({ id: agentId, name, role, publicKey: "pending", createdAt: now, updatedAt: now });
        // flair#1965 r2: this creates an Agent row through the RAW table, so the
        // Agent resource's post() stamp never runs. Stamp the local instance id
        // here (every create path carries it). See
        // resources/originator-instance.ts.
        await stampOriginatorOnCreate(agent);
        await (databases as any).flair.Agent.put(agent, c);
        // Test-only: holds the staged create so a competing create of the same
        // predictable id can commit first. Inert unless the fault-injection env
        // opt-in is set and armed.
        const pause = txnPausePoint("agentseed-agent-write", undefined, undefined, agent);
        if (pause) await pause;
        agentWritten = true;
      }

      // ── Soul entries ────────────────────────────────────────────────────────
      const soulEntries: any[] = [];
      const soulAttempts: Array<{ key: string; written: any | null }> = [];

      for (const [key, value] of Object.entries(merged)) {
        const id = `${agentId}:${key}`;
        const existing = await (databases as any).flair.Soul.get(id, c);
        if (existing) {
          soulEntries.push(existing); // skip — don't overwrite existing soul entries
          soulAttempts.push({ key, written: null });
          continue;
        }
        const entry = { id, agentId, key, value: String(value), provenance: soulProvenance(auth, source!, now), durability: "permanent", createdAt: now, updatedAt: now };
        // flair#1965 r2: raw Soul create — stamp the local instance id.
        await stampOriginatorOnCreate(entry);
        await (databases as any).flair.Soul.put(entry, c);
        // Test-only: holds the staged Soul create so a competing create of the
        // same key can commit first.
        const pause = txnPausePoint("agentseed-soul-write", undefined, undefined, entry);
        if (pause) await pause;
        soulEntries.push(entry);
        soulAttempts.push({ key, written: entry });
      }

      // ── Starter memories ──────────────────────────────────────────────────
      const memDefs = starterMemories && starterMemories.length > 0
        ? starterMemories
        : DEFAULT_MEMORIES(agentId, now);

      const memories: any[] = [];
      // Only seed memories if this is a first-time seed (none tagged onboarding yet)
      const hasOnboardingMemory = await (async () => {
        for await (const m of (databases as any).flair.Memory.search()) {
          if (m.agentId === agentId && (m.tags ?? []).includes("onboarding")) return true;
        }
        return false;
      })();
      if (hasOnboardingMemory) {
        // Re-seed: return existing onboarding memories without writing new ones
        for await (const m of (databases as any).flair.Memory.search()) {
          if (m.agentId === agentId && (m.tags ?? []).includes("onboarding")) memories.push(m);
        }
      } else {
        for (let i = 0; i < memDefs.length; i++) {
          const def = memDefs[i];
          // ── flair#1542: reject skill-tagged starter memories ──
          // This admin-only seed writes via the RAW table object, bypassing
          // Memory.post()/put()'s SkillScan gate + forced durability. A
          // skill-tagged starter memory would land unscanned — reject it (skills
          // are written via skill_store, not seeded as onboarding memories).
          const skillDenial = rejectSkillWritePath(def);
          if (skillDenial) return skillDenial;
          // A full random UUID in the id: this raw-table write is meant to create,
          // never to replace an existing record.
          const id = `seed-${agentId}-${i}-${Date.now()}-${randomUUID()}`;
          const record: any = {
            id,
            agentId,
            content: def.content,
            durability: def.durability ?? "persistent",
            tags: def.tags ?? ["onboarding"],
            source: "seed",
            createdAt: now,
            updatedAt: now,
            archived: false,
          };
          stripUndeclaredMemoryAttributes(record);
          // A1-iv items 1/3: the seed is a create path — strip server-stamped
          // fields and stamp a fresh incarnation token.
          stripServerStampedFields(record);
          record.instanceToken = randomUUID();
          // flair#1965 r2: raw Memory create — stamp the local instance id.
          await stampOriginatorOnCreate(record);
          // flair#2274: the seed is a Memory writer — give an ephemeral starter
          // memory the tier expiry the shared rule stamps (this raw put bypasses
          // Memory.post()/put()).
          stampEphemeralExpiry(record);
          await (databases as any).flair.Memory.put(record, c);
          noteMemoryUpsert(record);
          memories.push(record);
        }
      } // end !hasOnboardingMemory

      const pause = txnPausePoint("agentseed-before-commit");
      if (pause) await pause;
      return { agent, soulAttempts, memories };
    });

    if (agentWritten) invalidateAdminCache();
    if (outcome instanceof Response) return outcome;
    const { agent: seededAgent, soulAttempts, memories } = outcome;

    // The seed's transaction has committed. Report what is STORED, not what
    // this call staged: Harper can drop a staged create that lost to a newer
    // full write and still let the transaction commit. A failed or non-row read
    // is unverified, never "absent" and never the seed's own record.
    const unconfirmed = (what: string) => new Response(JSON.stringify({
      error: "agent_seed_unconfirmed",
      message: `the ${what} could not be read back after the seed committed; the seed's result is unverified`,
    }), { status: 500, headers: { "content-type": "application/json" } });

    let storedAgent: any;
    try {
      storedAgent = await (databases as any).flair.Agent.get(agentId, {});
    } catch (err) {
      console.error("AgentSeed: the post-commit Agent read failed", { agentId, err });
      return unconfirmed("agent record");
    }
    if (!isStoredRow(storedAgent, agentId, ["name", "publicKey", "createdAt"])) return unconfirmed("agent record");

    const soulEntries: any[] = [];
    const soulCreated: string[] = [];
    const soulAlreadyExisted: string[] = [];
    for (const attempt of soulAttempts) {
      const id = `${agentId}:${attempt.key}`;
      let stored: any;
      try {
        stored = await (databases as any).flair.Soul.get(id, {});
      } catch (err) {
        console.error("AgentSeed: the post-commit Soul read failed", { agentId, key: attempt.key, err });
        return unconfirmed(`Soul entry for key ${attempt.key}`);
      }
      if (!isStoredRow(stored, id, ["agentId", "key", "value", "createdAt"]) || stored.agentId !== agentId || stored.key !== attempt.key) return unconfirmed(`Soul entry for key ${attempt.key}`);
      soulEntries.push(stored);
      if (attempt.written && sameSeededSoul(stored, attempt.written)) soulCreated.push(attempt.key);
      else soulAlreadyExisted.push(attempt.key);
    }

    const created = agentWritten && sameSeededAgent(storedAgent, seededAgent);
    return {
      agent: storedAgent,
      soulEntries,
      memories,
      created,
      alreadyExisted: !created,
      soulCreated,
      soulAlreadyExisted,
    };
  }
}
