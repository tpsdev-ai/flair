// ─── BM25 candidate SECURITY filter (the hard cross-agent trust boundary) ────
// Per spec FLAIR-BM25-HYBRID-RETRIEVAL §26 + Sherlock's gate (§45-46):
//
//   "apply the SAME conditions[] filter (agent scoping, archived exclusion,
//    tag/subject) to the BM25 candidates BEFORE fusion. BM25-scoring other
//    agents' private memories and filtering only after fusion would leak
//    term-frequency / content metadata across agent boundaries. The conditions
//    filter MUST precede the union/fusion."
//
// The HNSW path gets this filter FOR FREE — Harper applies conditions[] inside
// Memory.search(). The BM25 pass runs in-process over the corpus, so it MUST
// re-apply the IDENTICAL predicate itself, BEFORE any scoring is fused or even
// returned. This module is the single source of that predicate.
//
// Harper-free + pure so the security test exercises the SHIPPED predicate
// directly (test/unit/bm25-security.test.ts).
//
// The condition shapes mirror EXACTLY what SemanticSearch.ts builds:
//   - leaf:  { attribute, comparator, value }
//   - group: { operator: "or", conditions: [...] }
// supported comparators: "equals", "not_equal" (the only ones SemanticSearch
// emits into conditions[]). An unknown comparator/shape is treated as NON-matching
// (fail closed — never leak on an unrecognized condition).

export interface LeafCondition {
  attribute: string;
  comparator: string;
  value: any;
}
export interface GroupCondition {
  operator: "or" | "and";
  conditions: Condition[];
}
export type Condition = LeafCondition | GroupCondition;

function isGroup(c: Condition): c is GroupCondition {
  return (c as GroupCondition).operator !== undefined && Array.isArray((c as GroupCondition).conditions);
}

// Evaluate a single leaf condition against a record. `tags` is array-valued in
// Harper; "equals" on an array attribute is membership (matches Harper's
// array-attribute equals semantics used by the tag filter).
function matchLeaf(cond: LeafCondition, record: any): boolean {
  const actual = record?.[cond.attribute];
  switch (cond.comparator) {
    case "equals":
      if (Array.isArray(actual)) return actual.includes(cond.value);
      return actual === cond.value;
    case "not_equal":
      // Harper "not_equal" semantics used for `archived not_equal true`: a record
      // WITHOUT the field (undefined) is included — it is "not equal" to true.
      if (Array.isArray(actual)) return !actual.includes(cond.value);
      return actual !== cond.value;
    default:
      // Unknown comparator → fail closed (do NOT pass a record on a condition we
      // can't evaluate; that could leak across the agent boundary).
      return false;
  }
}

function matchCondition(cond: Condition, record: any): boolean {
  if (isGroup(cond)) {
    const results = cond.conditions.map((c) => matchCondition(c, record));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  return matchLeaf(cond, record);
}

// AND across the top-level conditions[] (Harper's default for a conditions array
// — same as SemanticSearch passing them as the implicit-AND query.conditions).
export function matchesConditions(conditions: Condition[], record: any): boolean {
  for (const c of conditions) {
    if (!matchCondition(c, record)) return false;
  }
  return true;
}

// The per-record temporal/expiry filters the HNSW result loop applies AFTER the
// Harper conditions[] (SemanticSearch.ts lines ~194-198). The BM25 pass must
// apply these too so the BM25 candidate set is identical to what the HNSW path
// would surface for the same record.
export interface RecordTimeFilters {
  now?: number; // Date.now() override for testing; defaults to Date.now()
  sinceDate?: Date | null;
  asOf?: string | null;
}

export function passesRecordFilters(record: any, f: RecordTimeFilters = {}): boolean {
  const now = f.now ?? Date.now();
  if (record?.expiresAt && Date.parse(record.expiresAt) < now) return false;
  if (f.sinceDate && record?.createdAt && new Date(record.createdAt) < f.sinceDate) return false;
  if (f.asOf && record?.validFrom && record.validFrom > f.asOf) return false;
  if (f.asOf && record?.validTo && record.validTo <= f.asOf) return false;
  return true;
}

// The full BM25-candidate security filter: a record is a valid BM25 candidate
// ONLY if it passes BOTH the agent-scoping/archived/tag/subject conditions[] AND
// the per-record temporal filters — IDENTICAL to the HNSW candidate gate. Apply
// this to the corpus BEFORE building/scoring the union (defense at the boundary,
// not after fusion).
export function isAllowedBm25Candidate(
  record: any,
  conditions: Condition[],
  timeFilters: RecordTimeFilters = {},
): boolean {
  return matchesConditions(conditions, record) && passesRecordFilters(record, timeFilters);
}
