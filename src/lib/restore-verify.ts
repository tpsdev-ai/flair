/**
 * Restore compares archived Memory and Soul fields, excluding the server stamps
 * and derived fields below.
 *
 * Memory.put() (resources/Memory.ts):
 *   - excluded: `updatedAt`, `provenance`, and `instanceToken` (new on create,
 *     stored on update).
 *   - excluded: `originatorInstanceId` (local on create, stored on update) and
 *     `_originatorInstanceId`/`_syncedFrom`/`_syncedAt` (dropped on create,
 *     stored on update; resources/originator-instance.ts).
 *   - excluded: `retrievalCount`/`lastRetrieved` (MemoryHitStat read overlay).
 *   - compared: supplied `embedding` and its `embeddingModel`. Without an
 *     embedding, exclude both when embedding text permits generation; the
 *     generated model comes from getModelId() (Memory.ts:505-544, 1750-1753).
 *   - compared: `_safetyFlags` when neither content safety nor SkillScan runs;
 *     exclude during scans because they can replace or append flags
 *     (Memory.ts:1689-1712; skill-write.ts:125-157).
 *   - compared: `visibility` (defaulted on create when nullish), `createdAt`
 *     and `archived` (defaulted when nullish).
 *   - compared: `archivedAt`, `expiresAt`, `validFrom`; falsy values, including
 *     empty strings, can be replaced when archiving, writing an effective
 *     ephemeral durability, or supplying `supersedes`, respectively.
 *   - compared: `durability`; accepted skill writes force it to `persistent`
 *     (resources/skill-write.ts).
 *   - compared: the remaining listed attributes, including `meta`/`kind`.
 *
 * Soul.put() (resources/Soul.ts):
 *   - excluded: `updatedAt`, `provenance`, and `originatorInstanceId` (local on
 *     create, stored on update).
 *   - compared: `id`, `agentId`, `key`, `value`, `priority`, `metadata`,
 *     `durability`, `createdAt`.
 *
 * Agent rows retain the id-only check.
 * A field is compared only when the archived row owns it; conditional write
 * transformations of compared fields still fail closed on a mismatch.
 * `undefined` and `null` values compare equal; missing nested keys remain distinct;
 * objects compare with sorted keys;
 * arrays compare in order.
 */

import { protoSafeRecord } from "./proto-safe-record.js";

/** The columns restore compares per table. */
export const RESTORE_PRESERVED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Memory: Object.freeze([
    "id", "agentId", "content", "contentHash", "trigger", "visibility",
    "tags", "durability", "source", "type",
    "createdAt", "expiresAt", "usageCount", "promotionStatus", "promotedAt",
    "promotedBy", "archived", "archivedAt", "archivedBy", "parentId",
    "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
    "summary", "validFrom", "validTo", "metadata", "entities",
    "meta", "kind",
  ]),
  Soul: Object.freeze([
    "id", "agentId", "key", "value", "priority", "metadata", "durability", "createdAt",
  ]),
});

/** Undefined values equal null; missing nested keys remain distinct. */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    // A null-prototype copy built entry by entry: an own `__proto__` key
    // survives and stays visible to the comparison below (flair#2233, #2235).
    return protoSafeRecord(src, { keys: Object.keys(src).sort(), map: normalize });
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * Compare the archived row against the restored row over the listed fields
 * and return the NAMES of the fields that differ. Values are never returned,
 * so a caller can log the mismatch without leaking record content.
 * Non-`Memory`/`Soul` tables have no extra compared fields and return `[]`.
 */
export function comparePreservedFields(table: string, archived: unknown, restored: unknown): string[] {
  const fields = [...(RESTORE_PRESERVED_FIELDS[table] ?? [])];
  if (!archived || typeof archived !== "object" || Array.isArray(archived)) return [];
  if (!restored || typeof restored !== "object" || Array.isArray(restored)) return [];
  const from = archived as Record<string, unknown>;
  const to = restored as Record<string, unknown>;
  if (table === "Memory") {
    const skill = Array.isArray(from.tags) && from.tags.includes("skill");
    const skillTrigger = skill && typeof from.trigger === "string" && from.trigger.length > 0;
    const embedText = skillTrigger ? from.trigger : from.content;
    if (from.embedding || !embedText) fields.push("embedding", "embeddingModel");
    if (!from.content && !from.summary && !skillTrigger) fields.push("_safetyFlags");
  }
  const mismatched: string[] = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(from, field)) continue;
    if (!sameValue(from[field], to[field])) mismatched.push(field);
  }
  return mismatched;
}
