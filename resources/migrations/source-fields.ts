/**
 * source-fields.ts — SOURCE_FIELDS enumerations + the integrity envelope
 * hash (flair#695 invariant I + Kern verdict).
 *
 * "SOURCE_FIELDS constant per resource — enumerate source vs derived per
 * table, mechanically checked by the hash gate." The exact enumerations
 * below are copied verbatim from the Kern verdict (2026-07-11):
 *
 *   Memory source = content, agentId, durability, visibility, tags,
 *     createdAt, supersedes
 *     (derived: embedding, embeddingModel, retrievalCount, usageCount,
 *      lastRetrieved, provenance, originatorInstanceId)
 *   Relationship source = subject, predicate, object, agentId, validFrom,
 *     validTo
 *
 * "Pre+post content-hash ENVELOPE ... full-corpus hash-of-source-field-hashes
 * computed before first write and after completion; must match." — hashCorpus
 * below is exactly that: a per-row hash over ONLY the source fields, combined
 * (sorted by id, so iteration order never perturbs the result) into one
 * corpus-level hash.
 */
import { createHash } from "node:crypto";
import type { SourceTable } from "./types.js";

export const MEMORY_SOURCE_FIELDS = [
  "content",
  "agentId",
  "durability",
  "visibility",
  "tags",
  "createdAt",
  "supersedes",
] as const;

/** Not hashed — recomputable/mutable-by-design; listed for documentation + the mechanical-check tests. */
export const MEMORY_DERIVED_FIELDS = [
  "embedding",
  "embeddingModel",
  "retrievalCount",
  "usageCount",
  "lastRetrieved",
  "provenance",
  "originatorInstanceId",
] as const;

export const RELATIONSHIP_SOURCE_FIELDS = [
  "subject",
  "predicate",
  "object",
  "agentId",
  "validFrom",
  "validTo",
] as const;

export function sourceFieldsFor(table: SourceTable): readonly string[] {
  return table === "Memory" ? MEMORY_SOURCE_FIELDS : RELATIONSHIP_SOURCE_FIELDS;
}

/**
 * Deterministic canonicalization: sorts object keys recursively so the same
 * logical value always serializes identically regardless of property
 * insertion order (Harper doesn't guarantee field order is stable across
 * reads). `undefined` normalizes to `null` — a missing/undefined source
 * field and an explicit `null` must hash identically (both mean "no value"),
 * otherwise a legitimate no-op re-fetch could flip the corpus hash.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value === undefined ? null : value;
}

/** Hash of ONLY the listed fields off one row. Order-independent, missing-vs-null-independent. */
export function hashSourceFields(row: Record<string, unknown>, fields: readonly string[]): string {
  const picked: Record<string, unknown> = {};
  for (const f of fields) picked[f] = (row as Record<string, unknown>)[f] ?? null;
  return createHash("sha256").update(JSON.stringify(canonicalize(picked))).digest("hex");
}

/**
 * Hash-of-source-field-hashes over a corpus (or any subset of rows a caller
 * passes in — the content-transform gate calls this over just the touched
 * old rows, not the whole table). Rows are sorted by `id` before combining
 * so the result is independent of read/iteration order — two reads of the
 * same logical corpus in different order must hash identically.
 */
export function hashCorpus(rows: Array<Record<string, unknown>>, fields: readonly string[]): string {
  const perRow = rows
    .map((r) => ({ id: String((r as { id?: unknown }).id ?? ""), h: hashSourceFields(r, fields) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const combined = perRow.map((r) => `${r.id}:${r.h}`).join("|");
  return createHash("sha256").update(combined).digest("hex");
}
