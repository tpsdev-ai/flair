/**
 * dataset.ts — load LongMemEval_s, verify it against the pinned sha256, map
 * each question's multi-session haystack to the shared ingest shape, and select
 * a deterministic slice that covers every ability.
 *
 * The dataset file is NOT committed to the repo (278MB, distributed via HF LFS).
 * It is pinned instead by (HF repo, commit, file, sha256) in config.ts and
 * fetched with the exact curl in this directory's README. loadDataset() refuses
 * a file whose sha256 does not match the pin unless `allowUnpinned` — a number
 * produced against an unpinned dataset is not reproducible (Kern §8).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SessionHistory, SessionEvent } from "../../../packages/flair-bench/lib/index";
import type { LmeTask } from "./judge";
import { DATASET } from "./config";

export interface LmeTurn { role: string; content: string; has_answer?: boolean }
export interface LmeEntry {
  question_id: string;
  question_type: LmeTask;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids: string[];
}

export interface LmeSession { sessionId: string; date: string; events: SessionEvent[] }

/** The 5 LongMemEval abilities + abstention broken out separately. A question's
 *  ability is its type's bucket UNLESS it is an abstention question (`_abs`),
 *  which always rolls up to `abstention` regardless of type. */
export type Ability =
  | "information-extraction"
  | "multi-session"
  | "temporal-reasoning"
  | "knowledge-update"
  | "single-session-preference"
  | "abstention";

const TYPE_TO_ABILITY: Record<LmeTask, Ability> = {
  "single-session-user": "information-extraction",
  "single-session-assistant": "information-extraction",
  "multi-session": "multi-session",
  "temporal-reasoning": "temporal-reasoning",
  "knowledge-update": "knowledge-update",
  "single-session-preference": "single-session-preference",
};

/** The factual subset the F1/EM cross-check applies to (Kern §4b): the fact-
 *  bearing abilities, excluding preference (rubric) and abstention (no fact). */
export const FACTUAL_ABILITIES: Ability[] = [
  "information-extraction",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
];

export function isAbstention(entry: LmeEntry): boolean {
  return entry.question_id.includes("_abs");
}

export function abilityOf(entry: LmeEntry): Ability {
  return isAbstention(entry) ? "abstention" : TYPE_TO_ABILITY[entry.question_type];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadDataset(path: string, opts: { allowUnpinned?: boolean } = {}): LmeEntry[] {
  const actual = sha256File(path);
  if (actual !== DATASET.sha256) {
    const msg =
      `dataset sha256 mismatch: file=${actual} pinned=${DATASET.sha256}. ` +
      `Fetch the pinned file (see README) — a number against an unpinned dataset is not reproducible.`;
    if (!opts.allowUnpinned) throw new Error(msg);
    console.warn(`[longmemeval] WARNING (--allow-unpinned): ${msg}`);
  }
  const entries = JSON.parse(readFileSync(path, "utf8")) as LmeEntry[];
  if (!Array.isArray(entries)) throw new Error("dataset root is not an array");
  return entries;
}

/** Strip LongMemEval's weekday parenthetical and parse to an ISO timestamp.
 *  "2023/05/20 (Sat) 02:21" -> Date. Preserves ordering (the temporal ability
 *  depends on it). Returns undefined for an unparseable date (caller decides). */
export function parseLmeDate(s: string): string | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/\s*\([A-Za-z]{3}\)\s*/, " ").trim(); // drop "(Sat)"
  const m = cleaned.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) { const d = new Date(cleaned); return isNaN(+d) ? undefined : d.toISOString(); }
  const [, y, mo, da, hh, mm] = m;
  const d = new Date(Date.UTC(+y!, +mo! - 1, +da!, +hh!, +mm!));
  return isNaN(+d) ? undefined : d.toISOString();
}

/**
 * Map one question's haystack to the shared SessionHistory[] shape — one event
 * per turn (the locked per-event granularity), timestamps preserved from the
 * session's date, roles carried. Event ids are stable and derived from the
 * question + session + turn index, so a re-run produces byte-identical memories.
 */
export function entryToSessions(entry: LmeEntry): LmeSession[] {
  const out: LmeSession[] = [];
  for (let si = 0; si < entry.haystack_sessions.length; si++) {
    const turns = entry.haystack_sessions[si]!;
    const sessionId = entry.haystack_session_ids?.[si] ?? `${entry.question_id}-s${si}`;
    const dateRaw = entry.haystack_dates?.[si] ?? "";
    const iso = parseLmeDate(dateRaw);
    const events: SessionEvent[] = turns.map((t, ti) => ({
      id: `${entry.question_id}__s${si}__t${ti}`,
      content: `${t.role}: ${t.content}`,
      role: t.role,
      createdAt: iso,       // session-level date (LongMemEval provides per-session dates)
      durability: "standard",
    }));
    out.push({ sessionId, date: dateRaw, events });
  }
  return out;
}

/** The SessionHistory[] the shared ingestSessionHistory() consumes. */
export function toSessionHistories(sessions: LmeSession[]): SessionHistory[] {
  return sessions.map((s) => ({ sessionId: s.sessionId, events: s.events }));
}

/**
 * Deterministically select `n` questions that cover every ability. Sorts all
 * entries by question_id (stable), buckets by ability, then round-robins across
 * abilities so the slice spans them — always including at least some abstention
 * questions (the contamination/abstention behaviour must be represented). Given
 * (n, seed) the selection is reproducible; `seed` rotates the per-bucket start
 * so different slices are available without shuffling non-deterministically.
 */
export function selectSlice(entries: LmeEntry[], n: number, seed = 0): LmeEntry[] {
  const buckets = new Map<Ability, LmeEntry[]>();
  const sorted = [...entries].sort((a, b) => a.question_id.localeCompare(b.question_id));
  for (const e of sorted) {
    const ab = abilityOf(e);
    if (!buckets.has(ab)) buckets.set(ab, []);
    buckets.get(ab)!.push(e);
  }
  const abilities = [...buckets.keys()].sort();
  // Rotate each bucket by seed for stable-but-selectable variety.
  for (const ab of abilities) {
    const arr = buckets.get(ab)!;
    const rot = ((seed % arr.length) + arr.length) % arr.length;
    buckets.set(ab, arr.slice(rot).concat(arr.slice(0, rot)));
  }
  const picked: LmeEntry[] = [];
  const cursor = new Map<Ability, number>(abilities.map((a) => [a, 0]));
  while (picked.length < n) {
    let progressed = false;
    for (const ab of abilities) {
      if (picked.length >= n) break;
      const i = cursor.get(ab)!;
      const arr = buckets.get(ab)!;
      if (i < arr.length) {
        picked.push(arr[i]!);
        cursor.set(ab, i + 1);
        progressed = true;
      }
    }
    if (!progressed) break; // exhausted every bucket
  }
  // Stable output order (by question_id) so the slice — and its config hash — is
  // independent of round-robin insertion order.
  return picked.sort((a, b) => a.question_id.localeCompare(b.question_id));
}

/**
 * Deterministically select `n` questions of ONE ability — the shape a targeted
 * A/B needs. `selectSlice` round-robins ACROSS abilities and so cannot express
 * "60 temporal-reasoning questions"; that mismatch is exactly why the 30-question
 * smoke slice carried only a handful of temporal questions and scored 100% on
 * them (a ceiling — the check could not fire).
 *
 * Selection rule, stated so a reviewer can re-derive the exact slice:
 *   1. keep entries with abilityOf(e) === ability. Abstention questions roll up
 *      to "abstention" regardless of type, so asking for "temporal-reasoning"
 *      excludes the *_abs variants BY CONSTRUCTION (127 of the 133 temporal
 *      entries in LongMemEval_s).
 *   2. order by sha256("<seed>:" + question_id) ascending; ties (impossible in
 *      practice) broken by question_id.
 *   3. take the first n.
 *   4. emit sorted by question_id — stable output, so the config hash does not
 *      depend on draw order.
 *
 * Step 2 is a KEYED PSEUDO-RANDOM draw, not a lexicographic prefix, on purpose.
 * LongMemEval question_ids carry a meaningful prefix: `gpt4_*` marks the GPT-4-
 * generated subpopulation, 85 of the 127 temporal-reasoning questions (67%). A
 * lexicographic first-60 draws 18/60 of them (30%) — a sample skewed on question
 * provenance, which is a confound, not a sample. The hashed order draws 42/60
 * (70%), matching the population.
 *
 * Throws when fewer than `n` candidates exist: a silently-short slice would make
 * the reported n a lie.
 */
export function selectAbilitySlice(entries: LmeEntry[], ability: Ability, n: number, seed = 0): LmeEntry[] {
  const candidates = entries.filter((e) => abilityOf(e) === ability);
  if (candidates.length < n) {
    throw new Error(
      `selectAbilitySlice: asked for ${n} "${ability}" questions but only ${candidates.length} exist in this dataset`,
    );
  }
  const key = (e: LmeEntry) => createHash("sha256").update(`${seed}:${e.question_id}`).digest("hex");
  const keyed = candidates.map((e) => ({ e, k: key(e) }));
  keyed.sort((a, b) => a.k.localeCompare(b.k) || a.e.question_id.localeCompare(b.e.question_id));
  return keyed.slice(0, n).map((x) => x.e).sort((a, b) => a.question_id.localeCompare(b.question_id));
}

/** Where a question's answer actually lives, in the SAME id space the ingest
 *  writes (`<question_id>__s<sessionIdx>__t<turnIdx>`), so a retrieved-id list
 *  can be checked against it directly. */
export interface GoldEvidence {
  /** The sessions LongMemEval labels as containing the answer. */
  sessionIds: string[];
  /** Every ingested event id in those sessions. */
  sessionEventIds: string[];
  /** The event ids of the specific turns flagged `has_answer` — the tightest
   *  evidence label the dataset offers. */
  answerEventIds: string[];
}

/**
 * Map `answer_session_ids` + per-turn `has_answer` into ingested event ids.
 *
 * Verified against LongMemEval_s (2026-08-23, all 127 temporal-reasoning
 * questions): every answer_session_id resolves inside haystack_session_ids,
 * every question has at least one `has_answer` turn, and no `has_answer` turn
 * falls outside a labelled answer session. So a zero here means the retrieval
 * genuinely missed the evidence — it does not mean the label was unmappable.
 * `unresolvedSessionIds` is returned rather than swallowed so a future dataset
 * revision that breaks that property is loud instead of silently scoring 0.
 */
export function goldEvidenceFor(entry: LmeEntry): GoldEvidence & { unresolvedSessionIds: string[] } {
  const gold = new Set(entry.answer_session_ids ?? []);
  const sessionEventIds: string[] = [];
  const answerEventIds: string[] = [];
  const resolved = new Set<string>();
  for (let si = 0; si < entry.haystack_sessions.length; si++) {
    const sessionId = entry.haystack_session_ids?.[si] ?? `${entry.question_id}-s${si}`;
    if (!gold.has(sessionId)) continue;
    resolved.add(sessionId);
    const turns = entry.haystack_sessions[si]!;
    for (let ti = 0; ti < turns.length; ti++) {
      const id = `${entry.question_id}__s${si}__t${ti}`;
      sessionEventIds.push(id);
      if (turns[ti]!.has_answer) answerEventIds.push(id);
    }
  }
  return {
    sessionIds: [...gold],
    sessionEventIds,
    answerEventIds,
    unresolvedSessionIds: [...gold].filter((s) => !resolved.has(s)),
  };
}

export { TYPE_TO_ABILITY };
