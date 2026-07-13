/**
 * envelope.ts — the corpus-wide integrity envelope: "full-corpus
 * hash-of-source-field-hashes computed before first write and after
 * completion; must match" (flair#695 invariant IV /
 * Kern verdict), computed ONCE per boot cycle (K&S: "Envelope ASYNC after
 * ready — boot serves immediately on the old shape; pre-hash runs async;
 * migration deferred until it completes").
 *
 * `computeCorpusEnvelope` walks BOTH SOURCE_FIELDS tables (Memory,
 * Relationship) once and returns both the single aggregate `corpusHash`
 * (what schema-additive's full-envelope gate compares pre/post) AND the
 * full `perRowHash` breakdown (`${table}:${id}` -> hash) — the latter isn't
 * used by this module directly, but keeping the breakdown around lets a
 * caller answer "did THIS specific row's source fields change" without a
 * second full-corpus pass, if ever needed for diagnostics.
 *
 * Deliberately NOT scoped by risk class — this is the one integrity
 * computation the whole cycle shares; risk-class-specific gate strictness
 * (runner.ts) decides HOW MUCH of it each migration's completion gate
 * actually checks.
 */
import { createHash } from "node:crypto";
import { hashSourceFields, sourceFieldsFor } from "./source-fields.js";
import type { SourceTable } from "./types.js";

export interface TableAccessor {
  search(query: unknown): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
}

export interface CorpusEnvelope {
  perRowHash: Map<string, string>;
  corpusHash: string;
  computedAt: string;
}

export const ENVELOPE_TABLES: readonly SourceTable[] = ["Memory", "Relationship"];

export async function computeCorpusEnvelope(
  getTable: (table: SourceTable) => TableAccessor,
  now: () => Date,
): Promise<CorpusEnvelope> {
  const perRowHash = new Map<string, string>();
  const parts: string[] = [];

  for (const table of ENVELOPE_TABLES) {
    const fields = sourceFieldsFor(table);
    const accessor = getTable(table);
    for await (const row of accessor.search({})) {
      const id = String((row as { id?: unknown }).id ?? "");
      if (!id) continue;
      const h = hashSourceFields(row, fields);
      perRowHash.set(`${table}:${id}`, h);
      parts.push(`${table}:${id}:${h}`);
    }
  }

  parts.sort();
  const corpusHash = createHash("sha256").update(parts.join("|")).digest("hex");
  return { perRowHash, corpusHash, computedAt: now().toISOString() };
}
