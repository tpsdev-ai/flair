import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";
import { FORBIDDEN, UNAUTH, stampAttribution } from "./record-type-kit.js";
import { assertValidVisibility, assertVisibilityAllowedForDurability, PRIVATE_VISIBILITY } from "./memory-visibility.js";
import { assertValidDurability } from "./memory-durability.js";

export class FeedMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin elevation).
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous HTTP must NOT write.
    if (auth.kind === "anonymous") {
      return UNAUTH();
    }

    // No-forge attribution: use the kit's stampAttribution to stamp agentId
    // from the authenticated principal, never from the body.
    //
    // Mode choice: stamp-strict (reject 403 on mismatch) over stamp-default
    // (silent overwrite). This endpoint is the ingestion path — callers are MCP
    // clients and agent-side tool calls. The defect this fix addresses was
    // trusting a body-supplied identity; the correction is to always stamp from
    // the authenticated principal.
    //
    // Deciding point (adjudicated on PR #1071): a silent overwrite means a
    // buggy client never learns it is buggy — it keeps sending the wrong
    // agentId and keeps getting 200. A strict rejection surfaces the mismatch
    // so the caller can fix it. The concern about breaking callers that
    // harmlessly echo agentId back was checked: a full search of the repo and
    // workspace for FeedMemories and /FeedMemories returns only the resource
    // definition and its own tests — no SDK wrappers, no CLI commands, no
    // internal callers construct requests with a body-supplied agentId. A
    // caller echoing the correct agentId (matching the principal) passes
    // through stamp-strict unchanged; a caller echoing a wrong one is exactly
    // the bug this slice exists to prevent.
    const attr = stampAttribution(auth, content, 'agentId', 'stamp-strict', 'forbidden: cannot attribute a feed memory to another agent');
    if (attr.denied) return attr.denied;

    // Guard against body-supplied id targeting another agent's record.
    if (content?.id) {
      const existingRecord = await (databases as any).flair.Memory.get(content.id);
      if (existingRecord && existingRecord.agentId !== content.agentId) {
        return FORBIDDEN("forbidden: cannot write a feed memory owned by another agent");
      }
    }

    const agentId = content.agentId;
    const body = String(content?.content ?? "");
    if (!agentId || !body) {
      return new Response(JSON.stringify({ error: "agentId and content are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Write-side durability/visibility validation (#1009/#1238/#1257) ─────
    // This endpoint writes via the RAW table object below — NOT the exported
    // Memory resource — so it inherits NONE of Memory.post()/put()'s write
    // guards (Sherlock's #1261 review: ephemeral+shared, and any invalid
    // visibility or durability, landed through POST /FeedMemories untouched).
    // The three guards are applied here in the same order as Memory.post().
    //
    // Placed BEFORE the content-hash dedup early-return, deliberately: a
    // refused combination must refuse deterministically, not return 200 with
    // the existing record whenever a duplicate happens to exist.
    //
    // The effective durability for the tier rule is the one the record below
    // actually stamps — `content.durability ?? "standard"`. A raw table put
    // REPLACES the row, so even an update-in-place that omits durability
    // produces a "standard" row regardless of what it replaces; the stored
    // row's tier is decided entirely by this payload.
    const durability = content.durability ?? "standard";
    {
      const durabilityError = assertValidDurability(content.durability);
      if (durabilityError) {
        return new Response(JSON.stringify({ error: "invalid_durability", message: durabilityError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const visibilityError = assertValidVisibility(content.visibility);
      if (visibilityError) {
        return new Response(JSON.stringify({ error: "invalid_visibility", message: visibilityError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const tierError = assertVisibilityAllowedForDurability(durability, content.visibility);
      if (tierError) {
        return new Response(JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const now = new Date().toISOString();
    const contentHash = computeContentHash(agentId, body);

    const existing = await findExistingMemoryByContentHash((databases as any).flair.Memory.search(), agentId, contentHash);
    if (existing) return existing;

    const record = {
      ...content,
      id: content.id ?? `${agentId}-${Date.now()}`,
      agentId,
      content: body,
      contentHash,
      durability,
      createdAt: content.createdAt ?? now,
      updatedAt: content.updatedAt ?? now,
      archived: content.archived ?? false,
    };

    // flair#1257, omission leak: this endpoint stamps NO durability-keyed
    // visibility default (unlike Memory.post/put — Layer 1), so an ephemeral
    // feed write with visibility omitted would land with no visibility field
    // at all, which the read side resolves to NON-private (the migration
    // invariant). The refusal guard above cannot see an omission, so the
    // private-only tier invariant is closed here by stamping "private" on
    // exactly the ephemeral case. Deliberately NOT the general durability-
    // keyed default: stamping it for standard/persistent/permanent would flip
    // the visibility of every existing feed caller's writes — a behavioural
    // change this fix must not smuggle in.
    if (record.durability === "ephemeral" && (record.visibility === undefined || record.visibility === null)) {
      record.visibility = PRIVATE_VISIBILITY;
    }

    await (databases as any).flair.Memory.put(record);
    return record;
  }

  async *connect(target: any, incomingMessages: any) {
    const subscription = await (databases as any).flair.Memory.subscribe(target);

    if (!incomingMessages) {
      return subscription;
    }

    for await (const event of subscription) {
      yield event;
    }
  }
}
