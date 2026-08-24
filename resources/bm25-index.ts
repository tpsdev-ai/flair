// ─── Persistent, incrementally-maintained BM25 index (flair#1357) ────────────
//
// THE DEFECT THIS REPLACES: `retrieveCandidates()`'s hybrid leg used to fetch
// the ENTIRE scoped corpus out of Harper and call `buildBM25()` on it — for
// EVERY query. Tokenizing N documents and allocating N per-doc term maps per
// recall makes retrieval latency linear in store size: measured 5.6s p50 at
// 60k rows, 28.7s at 180k (flair#1357, LongMemEval take-6 latency journal),
// extrapolating past 30s at 250k. Vector-only recall over the same stores
// moved 2.4s → 4.7s, so the whole gap was the per-query index rebuild.
//
// Kern's ruling (2026-08-23) picked direction (a): a persistent index built on
// WRITE and maintained incrementally, over (b) cached-corpus + dirty-tracking
// (still pays a full scan+tokenize on the first cold query per scope, and its
// invalidation is a consistency problem in its own right) and (c) Harper-side
// lexical scoring (Harper has no native full-text/BM25 — its custom-index
// registry exports only HNSW, and its comparators are
// equals/in/contains/starts_with/ends_with/between, none of them ranked).
//
// ── THE HARD CONSTRAINT: ranking-identical, latency-only ────────────────────
// Recall is the product FLOOR and hybrid is default-on, so this module is NOT
// allowed to improve, degrade, or otherwise perturb ranking. It must return
// the SAME ids in the SAME order as `buildBM25(corpus).rank(q)` filtered to
// score>0 and sliced to SEM_LIMIT. Everything below that looks like a
// restriction exists to keep that promise:
//
//   1. BM25 statistics are CORPUS-SCOPED. `idf` reads N and df; the length
//      normalization reads avgdl. All three are computed over the set of
//      documents matching the query's `conditions[]` + temporal filters —
//      NOT over the whole store. A global-statistics index would return a
//      different ORDER, which is precisely what we may not do. So this index
//      holds every document once and derives per-query scoped statistics
//      (see `Aggregates` below).
//   2. Arithmetic is performed in the SAME ORDER as `buildBM25`, so the
//      doubles are bit-identical: query terms are accumulated in
//      `[...new Set(tokenize(q))]` order, and `avgdl` is a sum of integers
//      (exact in a double regardless of summation order) divided by N.
//   3. TIE-BREAKING IS NOT REPRODUCIBLE, SO TIES ARE DECLINED. Equal-scoring
//      documents come back from `buildBM25().rank()` in Harper's corpus
//      ITERATION order (stable sort), and that order is a query-planner
//      artifact: measured, a scan under the multi-agent read-scope OR-group
//      yields the reader's OWN agentId-indexed rows first and the rest after,
//      while the same scan under a tags/subject filter comes back in
//      primary-key order. When a tie could affect the returned window, `rank()`
//      returns null and the caller falls back to the legacy scan. See the
//      guard at the end of `rank()`.
//   4. ANYTHING THIS MODULE CANNOT REPRODUCE EXACTLY MUST NOT BE SERVED FROM
//      THE INDEX. `planQuery()` below is a conservative allowlist: an
//      unrecognised condition attribute, comparator, or shape returns a plan
//      of `null`, and the caller falls back to the legacy per-query corpus
//      scan. Unknown means SLOW, never means WRONG.
//
// Harper-free on purpose — same rationale as ./bm25.ts and ./scoring.ts: the
// scoring, the scope evaluation and the statistics derivation are unit-testable
// against the SHIPPED code with no live Harper. The Harper wiring (lazy build
// from a table scan, the change-feed subscription, the write hooks) lives in
// ./bm25-index-service.ts.
import { tokenize, BM25_K1, BM25_B } from "./bm25.js";
import {
  matchesConditions,
  passesRecordFilters,
  type Condition,
  type LeafCondition,
  type GroupCondition,
  type RecordTimeFilters,
} from "./bm25-filter.js";

// ─── What the index stores per document ─────────────────────────────────────
//
// SUPPORTED_SCOPE_ATTRS is the CLOSED set of record attributes a query may
// filter on and still be served from the index. It is closed for a security
// reason, not a performance one: `matchesConditions` evaluates `not_equal`
// against `record[attr]`, so a stored record MISSING an attribute the real row
// carries would PASS a `not_equal` filter it should fail — a scope leak with
// the shape of a ranking change. `planQuery()` rejects any condition naming an
// attribute outside this set, so an attribute we do not store can never be
// evaluated against a record that does not carry it.
//
// Every attribute `resources/SemanticSearch.ts` and
// `resources/MemoryBootstrap.ts` actually put into `conditions[]` is here:
// agentId + visibility (the read-scope OR-group, resources/memory-read-scope.ts),
// archived (the always-present exclusion), tags and subject (the optional
// filters). The rest are stored because they are cheap and a future caller
// filtering on them should get the fast path rather than a silent fallback.
export const SUPPORTED_SCOPE_ATTRS = [
  "agentId", "visibility", "archived", "tags", "subject", "durability",
  "source", "sessionId", "promotionStatus", "parentId", "derivedFrom",
  "supersedes", "contentHash", "embeddingModel",
] as const;

// Attributes the TEMPORAL filters read (resources/bm25-filter.ts's
// passesRecordFilters). Stored alongside the scope attributes; never
// filterable via `conditions[]` (they have their own parameters).
export const TEMPORAL_ATTRS = ["createdAt", "expiresAt", "validFrom", "validTo"] as const;

/** The `select` a corpus scan needs in order to feed this index. */
export const INDEX_SELECT: string[] = ["id", "content", ...SUPPORTED_SCOPE_ATTRS, ...TEMPORAL_ATTRS];

const SUPPORTED_ATTR_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_SCOPE_ATTRS);

/** A record as handed to the index — a projected Memory row. */
export interface IndexRecord {
  id: string;
  content?: string;
  [attr: string]: any;
}

// ─── Per-document slot ──────────────────────────────────────────────────────
interface Slot {
  id: string;
  /** Token count — `tokenize(content).length`, i.e. buildBM25's `docLen[i]`. */
  dl: number;
  /** Distinct-term count, for dead-posting accounting on delete. */
  nTerms: number;
  /** The scope/temporal attribute projection (see SUPPORTED_SCOPE_ATTRS). */
  meta: IndexRecord;
  /** Aggregate partition key — `agentId \0 visibility \0 archivedIsTrue`. */
  pkey: string;
  /**
   * `min(expiresAt, validTo)` as epoch ms, or Infinity. `passesRecordFilters`
   * excludes a record once EITHER is in the past, UNCONDITIONALLY (not gated
   * on `asOf`), so expiry is monotone in wall-clock time: a document that
   * falls out can never come back while the process runs. That is what lets
   * the aggregates below be swept forward instead of recomputed.
   */
  expiry: number;
}

// A term's posting list: parallel arrays, grown by doubling. Not a Map — at
// 250k docs × ~26 tokens (the measured live-corpus median,
// test/bench/corpus-profiler/profiles) that is ~6.5M postings, and a Map entry
// costs ~10x what an Int32Array cell does.
interface Posting {
  slots: Int32Array;
  tfs: Int32Array;
  len: number;
}

interface Agg { count: number; sumDl: number }

function emptyPosting(): Posting {
  return { slots: new Int32Array(4), tfs: new Int32Array(4), len: 0 };
}

function pushPosting(p: Posting, slot: number, tf: number): void {
  if (p.len === p.slots.length) {
    const slots = new Int32Array(p.slots.length * 2);
    slots.set(p.slots);
    const tfs = new Int32Array(p.tfs.length * 2);
    tfs.set(p.tfs);
    p.slots = slots;
    p.tfs = tfs;
  }
  p.slots[p.len] = slot;
  p.tfs[p.len] = tf;
  p.len++;
}

// ─── Query plan ─────────────────────────────────────────────────────────────
//
// A plan says HOW the per-query corpus statistics (N, avgdl) can be derived.
// `partitionConditions` are the conditions evaluable against a partition
// representative `{agentId, visibility, archived}`; `facet` is at most one
// tag- or subject-shaped restriction that the facet aggregates cover.
// `exact: true` means neither aggregate applies and the statistics must be
// computed by walking the stored metadata (still no Harper I/O and no
// tokenization, but linear in store size — see `stats()`).
interface QueryPlan {
  partitionConditions: Condition[];
  facetKey: string | null;
  facetValues: string[] | null;
  exact: boolean;
}

function isGroup(c: Condition): c is GroupCondition {
  return (c as GroupCondition).operator !== undefined && Array.isArray((c as GroupCondition).conditions);
}

/** Every attribute a condition tree names, or null if the tree has a shape
 *  `matchesConditions` would not evaluate the way we assume. */
function conditionAttrs(c: Condition, out: Set<string>): boolean {
  if (isGroup(c)) {
    if (c.operator !== "or" && c.operator !== "and") return false;
    for (const sub of c.conditions) if (!conditionAttrs(sub, out)) return false;
    return true;
  }
  const leaf = c as LeafCondition;
  if (typeof leaf.attribute !== "string") return false;
  // Only the two comparators `matchesConditions` implements. Anything else is
  // fail-closed THERE, which we must not silently reproduce as "in scope".
  if (leaf.comparator !== "equals" && leaf.comparator !== "not_equal") return false;
  out.add(leaf.attribute);
  return true;
}

/** Does this condition tree restrict a single facet attribute to a value set
 *  by `equals` alone (a leaf, or an OR-group of leaves on one attribute)? */
function asFacet(c: Condition): { attr: string; values: string[] } | null {
  if (!isGroup(c)) {
    const leaf = c as LeafCondition;
    if (leaf.comparator !== "equals") return null;
    return { attr: leaf.attribute, values: [String(leaf.value)] };
  }
  if (c.operator !== "or" || c.conditions.length === 0) return null;
  let attr: string | null = null;
  const values: string[] = [];
  for (const sub of c.conditions) {
    if (isGroup(sub)) return null;
    const leaf = sub as LeafCondition;
    if (leaf.comparator !== "equals") return null;
    if (attr === null) attr = leaf.attribute;
    else if (attr !== leaf.attribute) return null;
    values.push(String(leaf.value));
  }
  return attr ? { attr, values } : null;
}

const PARTITION_ATTRS: ReadonlySet<string> = new Set(["agentId", "visibility", "archived"]);
const FACET_ATTRS: ReadonlySet<string> = new Set(["tags", "subject"]);

export interface RankParams {
  /** Raw query text — tokenized exactly as `buildBM25().rank()` does. */
  q: string;
  conditions: Condition[];
  timeFilters?: RecordTimeFilters;
  /**
   * The caller's `scope.isAllowed` re-check. Evaluated per CANDIDATE always.
   * It is additionally evaluated once per aggregate PARTITION — which is only
   * sound if it reads nothing but `agentId`/`visibility` (the `ScopableRecord`
   * contract, resources/memory-read-scope.ts). `resolveReadScope()` marks its
   * predicate with `scopableOnly`; an unmarked predicate forces the exact
   * statistics walk instead of the aggregates. Unknown means slow, not wrong.
   */
  isAllowed?: ((record: any) => boolean) & { scopableOnly?: boolean };
  /** Top-N to return (SEM_LIMIT at the call site). */
  limit: number;
  /** Date.now() override, for tests. */
  now?: number;
}

export class Bm25Index {
  private slots: (Slot | null)[] = [];
  private slotOf = new Map<string, number>();
  private freeSlots: number[] = [];
  private postings = new Map<string, Posting>();
  private totalPostings = 0;
  private deadPostings = 0;

  /** Aggregates over LIVE, NOT-YET-EXPIRED docs, keyed by partition. */
  private partitions = new Map<string, Agg>();
  /** `${attr} ${value}` → partition → aggregate. Covers ONE facet
   *  restriction (tags or subject); a query naming both falls back. */
  private facets = new Map<string, Map<string, Agg>>();
  /** A representative `{agentId, visibility, archived}` per partition key, so
   *  a plan's partition conditions can be evaluated once per partition. */
  private partitionRep = new Map<string, IndexRecord>();

  /** Min-heap of (expiry, slot) for docs with a temporal bound. Entries may be
   *  stale (doc re-indexed or removed); validated on pop. */
  private expiryHeap: { ts: number; slot: number }[] = [];
  /** Wall clock the aggregates have been swept to. */
  private sweptTo = 0;
  /** Slots retired by the sweep — removed from the aggregates. */
  private retired = new Set<number>();

  get size(): number { return this.slotOf.size; }
  /** Live postings, for the memory-footprint assertions in the tests. */
  get postingCount(): number { return this.totalPostings - this.deadPostings; }
  get termCount(): number { return this.postings.size; }

  has(id: string): boolean { return this.slotOf.has(id); }

  clear(): void {
    this.slots = [];
    this.slotOf.clear();
    this.freeSlots = [];
    this.postings.clear();
    this.totalPostings = 0;
    this.deadPostings = 0;
    this.partitions.clear();
    this.facets.clear();
    this.partitionRep.clear();
    this.expiryHeap = [];
    this.sweptTo = 0;
    this.retired.clear();
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Add or replace a document. Deliberately NOT "diff the content and patch
   * the postings": an upsert always tombstones the old slot and appends a new
   * one. Detecting an unchanged body would need a content fingerprint, and a
   * fingerprint collision is a silently-wrong lexical index — the one failure
   * mode this index may not have. The cost is a dead posting run per update,
   * reclaimed by `compact()` below at O(1) amortized.
   */
  upsert(record: IndexRecord): void {
    const id = record?.id;
    if (typeof id !== "string" || id.length === 0) return;
    this.remove(id);

    const tokens = tokenize(record.content || "");
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    const meta: IndexRecord = { id };
    for (const attr of SUPPORTED_SCOPE_ATTRS) if (attr in record) meta[attr] = record[attr];
    for (const attr of TEMPORAL_ATTRS) if (attr in record) meta[attr] = record[attr];

    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.slots.length;
    const entry: Slot = {
      id,
      dl: tokens.length,
      nTerms: tf.size,
      meta,
      pkey: partitionKeyOf(meta),
      expiry: expiryOf(meta),
    };
    this.slots[slot] = entry;
    this.slotOf.set(id, slot);

    for (const [term, count] of tf) {
      let p = this.postings.get(term);
      if (!p) { p = emptyPosting(); this.postings.set(term, p); }
      pushPosting(p, slot, count);
    }
    this.totalPostings += tf.size;

    // A document whose bound has ALREADY passed is born retired: it can never
    // pass `passesRecordFilters`, so it must not enter the aggregates.
    if (entry.expiry <= this.sweptTo) {
      this.retired.add(slot);
    } else {
      this.addToAggregates(entry);
      if (entry.expiry !== Infinity) heapPush(this.expiryHeap, { ts: entry.expiry, slot });
    }
  }

  remove(id: string): void {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    const entry = this.slots[slot];
    this.slotOf.delete(id);
    this.slots[slot] = null;
    if (entry) {
      if (!this.retired.delete(slot)) this.removeFromAggregates(entry);
      this.deadPostings += entry.nTerms;
    }
    this.maybeCompact();
  }

  /**
   * Drop tombstoned postings and reclaim their slots. Triggered when a quarter
   * of the postings are dead, so the work is O(1) amortized per update. Slot
   * NUMBERS are only recycled here, after every posting referencing them is
   * gone — recycling earlier would let a stale posting resolve to an unrelated
   * document.
   */
  private maybeCompact(): void {
    if (this.deadPostings * 4 <= this.totalPostings || this.totalPostings === 0) return;
    let live = 0;
    for (const [term, p] of this.postings) {
      let w = 0;
      for (let r = 0; r < p.len; r++) {
        const s = p.slots[r];
        if (this.slots[s] === null) continue;
        p.slots[w] = s;
        p.tfs[w] = p.tfs[r];
        w++;
      }
      p.len = w;
      live += w;
      if (w === 0) this.postings.delete(term);
    }
    this.totalPostings = live;
    this.deadPostings = 0;
    this.freeSlots = [];
    for (let s = 0; s < this.slots.length; s++) if (this.slots[s] === null) this.freeSlots.push(s);
  }

  // ─── Aggregates ───────────────────────────────────────────────────────────

  private addToAggregates(entry: Slot): void {
    bump(this.partitions, entry.pkey, entry.dl, 1);
    if (!this.partitionRep.has(entry.pkey)) {
      this.partitionRep.set(entry.pkey, {
        id: "",
        agentId: entry.meta.agentId,
        visibility: entry.meta.visibility,
        archived: entry.meta.archived,
      });
    }
    for (const fk of facetKeysOf(entry.meta)) {
      let m = this.facets.get(fk);
      if (!m) { m = new Map(); this.facets.set(fk, m); }
      bump(m, entry.pkey, entry.dl, 1);
    }
  }

  private removeFromAggregates(entry: Slot): void {
    bump(this.partitions, entry.pkey, -entry.dl, -1);
    for (const fk of facetKeysOf(entry.meta)) {
      const m = this.facets.get(fk);
      if (m) bump(m, entry.pkey, -entry.dl, -1);
    }
  }

  /** Advance the aggregates to `now` by retiring every document whose
   *  expiresAt/validTo has passed. Amortized O(1) per document per lifetime. */
  private sweep(now: number): void {
    if (now <= this.sweptTo) { this.sweptTo = Math.max(this.sweptTo, now); return; }
    this.sweptTo = now;
    while (this.expiryHeap.length > 0 && this.expiryHeap[0].ts < now) {
      const top = heapPop(this.expiryHeap)!;
      const entry = this.slots[top.slot];
      if (!entry || entry.expiry !== top.ts) continue; // stale heap entry
      if (this.retired.has(top.slot)) continue;
      this.retired.add(top.slot);
      this.removeFromAggregates(entry);
    }
  }

  // ─── Planning ─────────────────────────────────────────────────────────────

  /**
   * Decide how this query's corpus statistics can be derived, or return null
   * if the index must not serve it at all. Conservative by construction: every
   * branch that cannot be reproduced EXACTLY either downgrades to the linear
   * exact walk or refuses outright.
   */
  planQuery(conditions: Condition[], timeFilters: RecordTimeFilters, isAllowed?: RankParams["isAllowed"]): QueryPlan | null {
    const attrs = new Set<string>();
    for (const c of conditions) {
      if (!conditionAttrs(c, attrs)) return null; // unknown shape/comparator
    }
    for (const a of attrs) if (!SUPPORTED_ATTR_SET.has(a)) return null; // unstored attribute

    // `sinceDate`/`asOf` restrict the corpus by createdAt/validFrom/validTo,
    // which the aggregates do not model. Exact walk.
    const temporallyFiltered = Boolean(timeFilters?.sinceDate || timeFilters?.asOf);
    // An isAllowed we cannot legally hoist to the partition level.
    const hoistable = !isAllowed || isAllowed.scopableOnly === true;

    const partitionConditions: Condition[] = [];
    let facet: { attr: string; values: string[] } | null = null;
    let exact = temporallyFiltered || !hoistable;

    for (const c of conditions) {
      const cAttrs = new Set<string>();
      conditionAttrs(c, cAttrs);
      if ([...cAttrs].every((a) => PARTITION_ATTRS.has(a))) { partitionConditions.push(c); continue; }
      const f = asFacet(c);
      if (f && FACET_ATTRS.has(f.attr) && facet === null) { facet = f; continue; }
      // Mixed-attribute group, a second facet, or a non-equals restriction on
      // a facet attribute: the aggregates cannot express it.
      exact = true;
      partitionConditions.push(c);
    }

    return {
      partitionConditions,
      facetKey: exact ? null : facet ? facet.attr : null,
      facetValues: exact ? null : facet ? facet.values : null,
      exact,
    };
  }

  /**
   * N and avgdl over the scoped corpus — the two statistics `buildBM25` derives
   * from the whole fetched corpus. Returns the EXACT values the legacy path
   * would have computed.
   */
  private stats(
    plan: QueryPlan,
    conditions: Condition[],
    timeFilters: RecordTimeFilters,
    isAllowed: RankParams["isAllowed"],
    now: number,
  ): { N: number; sumDl: number } {
    if (plan.exact) {
      // Linear in stored documents, but over in-memory metadata only: no
      // Harper fetch, no tokenization, no per-doc allocation. This is the
      // fallback for sinceDate/asOf/tag+subject-together queries.
      let N = 0, sumDl = 0;
      for (const entry of this.slots) {
        if (!entry) continue;
        if (!matchesConditions(conditions, entry.meta)) continue;
        if (!passesRecordFilters(entry.meta, { ...timeFilters, now })) continue;
        if (isAllowed && !isAllowed(entry.meta)) continue;
        N++;
        sumDl += entry.dl;
      }
      return { N, sumDl };
    }

    // Aggregate path: O(#partitions), independent of store size.
    const source = plan.facetKey
      ? mergeFacetAggregates(this.facets, plan.facetKey, plan.facetValues!)
      : this.partitions;
    let N = 0, sumDl = 0;
    for (const [pkey, agg] of source) {
      if (agg.count === 0) continue;
      const rep = this.partitionRep.get(pkey);
      if (!rep) continue;
      if (!matchesConditions(plan.partitionConditions, rep)) continue;
      if (isAllowed && !isAllowed(rep)) continue;
      N += agg.count;
      sumDl += agg.sumDl;
    }
    return { N, sumDl };
  }

  /**
   * The lexical leg: the ids `buildBM25(scopedCorpus).rank(q)` would place in
   * the top `limit` after dropping score-0 documents. Returns null when the
   * index declines the query (see `planQuery`), in which case the caller MUST
   * run the legacy corpus scan.
   *
   * FULLY SYNCHRONOUS on purpose. A Harper component worker is single-threaded
   * JavaScript, so a body with no `await` in it cannot observe a write landing
   * part-way through: every query sees one consistent index snapshot, the same
   * guarantee the old single-pass corpus fetch gave.
   */
  rank(params: RankParams): string[] | null {
    const { q, conditions, limit } = params;
    const timeFilters: RecordTimeFilters = params.timeFilters ?? {};
    const isAllowed = params.isAllowed;
    const now = params.now ?? timeFilters.now ?? Date.now();

    const plan = this.planQuery(conditions, timeFilters, isAllowed);
    if (!plan) return null;

    this.sweep(now);

    const qToks = [...new Set(tokenize(q))];
    if (qToks.length === 0) return [];

    const effectiveFilters: RecordTimeFilters = { ...timeFilters, now };
    // Scope decisions are memoized per slot: a slot reached through several
    // query terms is evaluated once, and the df pass and the scoring pass
    // agree by construction.
    const inScope = new Map<number, boolean>();
    const check = (slot: number): boolean => {
      let v = inScope.get(slot);
      if (v !== undefined) return v;
      const entry = this.slots[slot];
      v = !!entry
        && matchesConditions(conditions, entry.meta)
        && passesRecordFilters(entry.meta, effectiveFilters)
        && (!isAllowed || isAllowed(entry.meta));
      inScope.set(slot, v);
      return v;
    };

    // ── Pass 1: df(t) over the SCOPED corpus ────────────────────────────────
    const df: number[] = new Array(qToks.length).fill(0);
    const lists: (Posting | undefined)[] = new Array(qToks.length);
    for (let i = 0; i < qToks.length; i++) {
      const p = this.postings.get(qToks[i]);
      lists[i] = p;
      if (!p) continue;
      let n = 0;
      for (let r = 0; r < p.len; r++) if (check(p.slots[r])) n++;
      df[i] = n;
    }

    const { N, sumDl } = this.stats(plan, conditions, timeFilters, isAllowed, now);
    const avgdl = sumDl / (N || 1);
    const lengthNorm = avgdl || 1;

    // ── Pass 2: score ───────────────────────────────────────────────────────
    // Terms are visited in `qToks` order and contributions are accumulated in
    // that order per document — the same addition sequence `buildBM25().rank()`
    // uses, so the resulting doubles are bit-identical.
    const scores = new Map<number, number>();
    for (let i = 0; i < qToks.length; i++) {
      const p = lists[i];
      if (!p) continue;
      const n = df[i];
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (let r = 0; r < p.len; r++) {
        const slot = p.slots[r];
        if (!check(slot)) continue;
        const f = p.tfs[r];
        const dl = this.slots[slot]!.dl;
        const numer = f * (BM25_K1 + 1);
        const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / lengthNorm));
        scores.set(slot, (scores.get(slot) || 0) + idf * (numer / denom));
      }
    }

    // ── Rank ────────────────────────────────────────────────────────────────
    // score>0 only (buildBM25's caller drops zeroes), then score DESC with ties
    // broken by ascending id — the stable-sort-over-corpus-order semantics of
    // the legacy path, given Harper scans in primary-key order.
    const out: { id: string; score: number }[] = [];
    for (const [slot, score] of scores) {
      if (score > 0) out.push({ id: this.slots[slot]!.id, score });
    }
    // Score DESC. The id component only makes the sort a total order (so the
    // ambiguity check below sees equal scores adjacent and the function is
    // deterministic) — it never decides a RETURNED order, because any tie
    // inside the window makes this function return null.
    out.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // ── TIE AMBIGUITY: DECLINE RATHER THAN GUESS ────────────────────────────
    // `buildBM25().rank()` sorts by score with `Array.prototype.sort`, which is
    // stable, so EQUAL-SCORING documents come back in the order Harper yielded
    // the corpus. That order is a QUERY-PLANNER ARTIFACT, not a property this
    // index can reconstruct: measured against a live instance
    // (test/integration/bm25-index-scan-order-1357.test.ts), a scan under the
    // multi-agent read-scope OR-group yields the READER'S OWN agentId-indexed
    // rows first and everything else after — while the same scan under a
    // tags/subject filter comes back in primary-key order. Different plan,
    // different tie order, same query text.
    //
    // Reproducing that would mean reproducing Harper's planner. Reordering
    // ties ourselves would be a RANKING CHANGE, which this work is explicitly
    // not allowed to make. So when a score tie could affect the returned
    // window, the index declines and the caller's legacy corpus scan answers —
    // slower, and exactly right. Ties strictly BELOW the window cannot change
    // which ids are returned or in what order, so they are ignored; the pair
    // STRADDLING the boundary can (it decides the last slot), so it is checked.
    const bound = Math.min(out.length, limit + 1);
    for (let i = 1; i < bound; i++) {
      if (out[i].score === out[i - 1].score) return null;
    }
    return out.slice(0, limit).map((r) => r.id);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function bump(map: Map<string, Agg>, key: string, dl: number, count: number): void {
  const a = map.get(key);
  if (a) { a.count += count; a.sumDl += dl; return; }
  map.set(key, { count, sumDl: dl });
}

function partitionKeyOf(meta: IndexRecord): string {
  return `${meta.agentId ?? ""} ${meta.visibility ?? ""} ${meta.archived === true ? "1" : "0"}`;
}

function* facetKeysOf(meta: IndexRecord): Generator<string> {
  const tags = meta.tags;
  if (Array.isArray(tags)) for (const t of tags) yield `tags ${String(t)}`;
  if (meta.subject !== undefined && meta.subject !== null) yield `subject ${String(meta.subject)}`;
}

function mergeFacetAggregates(
  facets: Map<string, Map<string, Agg>>,
  attr: string,
  values: string[],
): Map<string, Agg> {
  // A record carries ONE subject and is counted once per tag it holds, and a
  // tag-equals filter names a single tag — so summing across `values` never
  // double-counts a document.
  if (values.length === 1) return facets.get(`${attr} ${values[0]}`) ?? new Map();
  const merged = new Map<string, Agg>();
  for (const v of values) {
    const m = facets.get(`${attr} ${v}`);
    if (!m) continue;
    for (const [pkey, agg] of m) bump(merged, pkey, agg.sumDl, agg.count);
  }
  return merged;
}

function expiryOf(meta: IndexRecord): number {
  let e = Infinity;
  const exp = meta.expiresAt ? Date.parse(meta.expiresAt) : NaN;
  if (!Number.isNaN(exp)) e = Math.min(e, exp);
  const vt = meta.validTo ? Date.parse(meta.validTo) : NaN;
  if (!Number.isNaN(vt)) e = Math.min(e, vt);
  return e;
}

// Binary min-heap on `.ts`.
function heapPush(h: { ts: number; slot: number }[], v: { ts: number; slot: number }): void {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (h[parent].ts <= h[i].ts) break;
    const tmp = h[parent]; h[parent] = h[i]; h[i] = tmp;
    i = parent;
  }
}

function heapPop(h: { ts: number; slot: number }[]): { ts: number; slot: number } | undefined {
  if (h.length === 0) return undefined;
  const top = h[0];
  const last = h.pop()!;
  if (h.length > 0) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l].ts < h[m].ts) m = l;
      if (r < h.length && h[r].ts < h[m].ts) m = r;
      if (m === i) break;
      const tmp = h[m]; h[m] = h[i]; h[i] = tmp;
      i = m;
    }
  }
  return top;
}
