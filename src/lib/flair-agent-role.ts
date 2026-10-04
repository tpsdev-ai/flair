/**
 * flair-agent-role.ts — the `flair_agent` Harper role's grant spec, shared by
 * the CLI (`ensureFlairAgentRole`, src/cli.ts) and the server's startup check
 * (resources/flair-agent-role-boot.ts). No Harper imports.
 */

// ─── flair_agent role ────────────────────────────────────────────────────────
//
// The auth reshape replaces the global gate's "verified agent borrows admin
// super_user" elevation with a real, least-privilege Harper role. After an
// agent's Ed25519 signature verifies, resources resolve the request to the
// shared `flair_agent`-roled user instead of admin. Critically: with no
// `super_user` and no operations grants, /sql and /graphql become NATIVELY 403
// for agents (the raw-query block the gate hand-rolled is now enforced by
// Harper itself).

// Harper 5.0.21 add_role requires an `attribute_permissions` array on EVERY table
// grant (empty = no attribute-level restriction, so the table-level CRUD applies);
// omitting it makes add_role reject the whole spec ("Missing 'attribute_permissions'
// array"). Validated live against a spawned Harper. This helper guarantees the
// array is never forgotten. Also: `cluster_user` is NOT a valid top-level key —
// Harper reads unrecognized top-level keys as database names ("database
// 'cluster_user' does not exist"); only super_user / structure_user are recognized.
const grant = (read: boolean, insert: boolean, update: boolean, del: boolean) =>
  ({ read, insert, update, delete: del, attribute_permissions: [] });

/** Canonical permission spec for flair_agent (least-privilege; real @table names). */
export const FLAIR_AGENT_PERMISSION = {
  super_user: false,
  structure_user: false,
  flair: {
    tables: {
      // Core agent-owned data — CRUD envelope.
      Memory:          grant(true,  true,  true,  true),
      MemoryCandidate: grant(true,  true,  true,  true),
      MemoryGrant:     grant(true,  true,  true,  true),
      // Asset (images-in-Flair slice 1). Harper authorizes BEFORE Asset.post
      // runs, so a de-elevated flair_agent needs the table grant or signed
      // POST /Asset 403s as AccessViolation (Kern P0). CRUD envelope;
      // owner-only + write-time size/MIME gates live in resources/Asset.ts.
      Asset:           grant(true,  true,  true,  true),
      Soul:            grant(true,  true,  true,  false),
      OrgEvent:        grant(true,  true,  true,  true),
      WorkspaceState:  grant(true,  true,  true,  true),
      Relationship:    grant(true,  true,  true,  true),
      // Flair Relay S1 (flair#1521). Harper authorizes BEFORE the resource
      // methods run, so a de-elevated flair_agent needs the table grant OR it
      // 403s on POST /Message before relaySend is reached (Kern P0-2). read =
      // the party-scoped collection (Message.search); insert = send via post().
      // update = FALSE (least privilege, Kern P0 blocker): the ack's write goes
      // through the IN-PROCESS static accessor (relayConsume → deps.messages.put),
      // which bypasses role gates entirely — the same raw-put seam Federation.ts
      // relies on — so update:true is NOT needed for any legitimate path. Leaving
      // it granted let PATCH /Message/<id> reach Table's update verb, whose
      // authorize step consults update:true and PASSES for any de-elevated agent,
      // bypassing Message.put()'s FORBIDDEN guard AND relayConsume's recipient-only
      // check (Message has no patch() at the platform level → TableResource.patch
      // runs update()+save() directly). delete = false: direct deletes are
      // admin/internal only. Message.patch() also guards the verb in-resource.
      Message:         grant(true,  true,  false, false),
      Integration:     grant(true,  true,  true,  true),
      Credential:      grant(true,  true,  true,  true),
      Presence:        grant(true,  true,  true,  false),
      // MemoryUsage (flair#683): the usage-feedback dedup ledger. Read (own
      // contributions, scoped in resources/MemoryUsage.ts) + insert (a fresh
      // contribution row) only — NO update/delete. This is load-bearing, not
      // just least-privilege tidiness: the dedup rule ("(agent, memory)
      // contributes ≤ 1") is enforced by requiring a NEW ledger row before
      // any usageCount bump; if an agent could delete its own row, it could
      // re-trigger the /RecordUsage endpoint for the same memory indefinitely
      // (create → count → delete → count again → repeat), defeating the cap
      // entirely. See resources/MemoryUsage.ts's module doc.
      MemoryUsage:     grant(true,  true,  false, false),
      // MemoryHitStat (flair#1528): internal search-hit ledger. No agent REST
      // surface (@table without @export). Counts overlay onto Memory reads.
      MemoryHitStat:   grant(false, false, false, false),
      // Agent: read for discovery, update own card; creation/removal is admin.
      Agent:           grant(true,  false, true,  false),
      // Read-only reference data.
      Instance:        grant(true,  false, false, false),
      // flair#2141 S1: org-scope skill assignments. Agents read them; every
      // write is operator/internal only (resources/OrgSkillAssignment.ts), so
      // no write grant. The history table has no direct REST route.
      OrgSkillAssignment:        grant(true,  false, false, false),
      OrgSkillAssignmentHistory: grant(false, false, false, false),
      // flair#2139 S1: instruction-version history. Read only — the resource
      // itself denies every mutation verb to every principal, and the only
      // application writer is the in-process append helper. See resources/InstructionVersion.ts.
      InstructionVersion: grant(true, false, false, false),
      // Federation / OAuth / IdP / internal — system + admin only; agents get none.
      Peer:          grant(false, false, false, false),
      PairingToken:  grant(false, false, false, false),
      SyncLog:       grant(false, false, false, false),
      OAuthClient:   grant(false, false, false, false),
      OAuthToken:    grant(false, false, false, false),
      OAuthAuthCode: grant(false, false, false, false),
      IdpConfig:     grant(false, false, false, false),
      IdJagReplay:   grant(false, false, false, false),
    },
  },
};

export const FLAIR_AGENT_ROLE_NAME = "flair_agent";

/** One Harper operation: the ops API from the CLI, `server.operation` in-process. */
export type RoleOperation = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * Brings an existing `flair_agent` role to FLAIR_AGENT_PERMISSION (flair#2141
 * S1): "updated" after an `alter_role`, "unchanged" when it already matches,
 * "absent" when the instance has no such role (this never creates it). Throws
 * when the role list cannot be read; nothing is written then.
 */
export async function alignFlairAgentRole(op: RoleOperation): Promise<"updated" | "unchanged" | "absent"> {
  const roles = await op({ operation: "list_roles" });
  if (!Array.isArray(roles)) throw new Error("list_roles did not return a list of roles");
  const existing = roles.find((r: any) => r?.role === FLAIR_AGENT_ROLE_NAME || r?.name === FLAIR_AGENT_ROLE_NAME);
  if (!existing) return "absent";
  const permission = existing.permission ?? existing.role?.permission;
  if (JSON.stringify(permission) === JSON.stringify(FLAIR_AGENT_PERMISSION)) return "unchanged";
  // Harper's alter_role addresses the role by its `id`.
  if (typeof existing.id !== "string" || existing.id.length === 0) throw new Error("the flair_agent role has no id");
  await op({ operation: "alter_role", id: existing.id, role: FLAIR_AGENT_ROLE_NAME, permission: FLAIR_AGENT_PERMISSION });
  return "updated";
}
