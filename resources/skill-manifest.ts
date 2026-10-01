/**
 * skill-manifest.ts — the structured skills manifest in every successful
 * bootstrap response (flair#2141 S1b). No Harper imports.
 *
 * `resolveSkillManifest` turns an agent's `skill-assignment` Soul rows into two
 * lists:
 *   - `skills`: the winners only — `{ name, skillId, scope, priority, source }`,
 *     where `skillId` is the skill-tagged Memory row to fetch with `skill_get`.
 *   - `diagnostics`: assignments refused (a non-durable source or an
 *     equal-priority tie) or superseded, and winners whose name does not
 *     resolve to exactly one skill row (unresolved or ambiguous).
 * The priority/tie rules are `resolveActiveSkills` (skill-provenance.ts), run
 * first; name resolution runs on its winners. Every candidate has scope "own"
 * (the target agent's own assignments); flair#2141 S1 adds org assignments and
 * opt-outs ahead of the priority rules.
 *
 * The manifest strings (`name`, `source`) come from Soul `skill-assignment`
 * rows and reach the agent's context without SkillScan. That is safe only
 * because no agent key can write those rows; only operator credentials and
 * Flair's own internal paths can (resources/soul-write-policy.ts). Widening who
 * may write them changes this render path.
 */

import {
  formatBase,
  parseSkillMetadata,
  resolveActiveSkills,
  type SkillAssignmentInput,
} from "./skill-provenance.js";
import { isSkillWrite } from "./skill-write.js";

export type SkillScope = "own";

export interface SkillManifestEntry {
  name: string;
  skillId: string;
  scope: SkillScope;
  priority: string;
  source: string | null;
}

export type SkillDiagnosticDecision = "superseded" | "refused" | "unresolved" | "ambiguous";

export interface SkillDiagnostic {
  name: string;
  scope: SkillScope;
  priority: string;
  source: string | null;
  decision: SkillDiagnosticDecision;
  reason: string;
  /** Ambiguous only: the skill row ids that tied at the deciding step. */
  candidates?: string[];
}

/** A skill-tagged Memory row, as far as name resolution reads it. */
export interface SkillRow {
  id?: unknown;
  agentId?: unknown;
  tags?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
  archived?: unknown;
  validTo?: unknown;
  expiresAt?: unknown;
}

/** The Memory fields the bootstrap skill-row query selects. */
export const SKILL_ROW_SELECT = [
  "id", "agentId", "visibility", "tags", "metadata", "createdAt", "archived", "validTo", "expiresAt",
];

export type SkillRefResolution =
  | { kind: "resolved"; skillId: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "ambiguous"; reason: string; candidates: string[] };

/** A skill row's name: `metadata.name` (skill_store folds it there). */
export function skillNameOf(row: SkillRow): string | undefined {
  const name = parseSkillMetadata(row.metadata).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function isPast(value: unknown, now: number): boolean {
  return typeof value === "string" && value.length > 0 && Date.parse(value) < now;
}

/**
 * The rows a name may resolve to: skill-tagged, readable by the target agent
 * (`isReadable`, the read-scope predicate `skill_get` applies), not archived,
 * and not closed (`validTo`) or expired (`expiresAt`).
 */
export function resolvableSkillRows(
  rows: SkillRow[],
  isReadable: (row: any) => boolean,
  now: number = Date.now(),
): SkillRow[] {
  return rows.filter((row) =>
    typeof row.id === "string"
    && isSkillWrite(row)
    && isReadable(row)
    && row.archived !== true
    && !isPast(row.expiresAt, now)
    && !isPast(row.validTo, now));
}

/**
 * Resolve a name-only assignment to one skill row. Order: the target agent's
 * own row with that name, then the oldest `createdAt` (flair#2141 S2 adds the
 * org seed row between the two). More than one row at the deciding step is
 * ambiguous, as is an oldest step over two or more rows where a `createdAt`
 * does not parse.
 */
export function resolveSkillRef(name: string, rows: SkillRow[], agentId: string): SkillRefResolution {
  const named = rows.filter((row) => skillNameOf(row) === name);
  const ids = (list: SkillRow[]) => list.map((row) => row.id as string).sort();

  const own = named.filter((row) => row.agentId === agentId);
  if (own.length === 1) return { kind: "resolved", skillId: own[0].id as string };
  if (own.length > 1) {
    return { kind: "ambiguous", reason: `${own.length} of the agent's own skill rows have this name`, candidates: ids(own) };
  }

  if (named.length === 0) return { kind: "unresolved", reason: "no readable, live skill row has this name" };
  if (named.length === 1) return { kind: "resolved", skillId: named[0].id as string };

  const times = named.map((row) => (typeof row.createdAt === "string" ? Date.parse(row.createdAt) : NaN));
  const oldest = Math.min(...times);
  const atOldest = Number.isNaN(oldest) ? named : named.filter((_, i) => times[i] === oldest);
  if (atOldest.length === 1) return { kind: "resolved", skillId: atOldest[0].id as string };
  return {
    kind: "ambiguous",
    reason: `${named.length} readable skill rows have this name and none is uniquely the oldest`,
    candidates: ids(atOldest),
  };
}

/** The "## Active Skills" prose line for a manifest entry. */
export function skillLine(entry: SkillManifestEntry): string {
  return formatBase(entry.name, entry.priority, entry.source ?? undefined);
}

function compareDiagnostics(a: SkillDiagnostic, b: SkillDiagnostic): number {
  return a.name.localeCompare(b.name)
    || a.decision.localeCompare(b.decision)
    || (a.source ?? "").localeCompare(b.source ?? "")
    || a.priority.localeCompare(b.priority)
    || a.reason.localeCompare(b.reason);
}

/**
 * The manifest for one agent: `assignments` are its `skill-assignment` Soul
 * rows, `rows` the skill rows it may resolve to (see resolvableSkillRows).
 * `skills` is sorted by name; `diagnostics` by name, decision, source,
 * priority and reason.
 */
export function resolveSkillManifest(
  assignments: SkillAssignmentInput[],
  rows: SkillRow[],
  agentId: string,
): { skills: SkillManifestEntry[]; diagnostics: SkillDiagnostic[] } {
  const skills: SkillManifestEntry[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const outcome of resolveActiveSkills(assignments).outcomes) {
    const scope: SkillScope = "own";
    const source = outcome.source ?? null;
    if (!outcome.loaded) {
      diagnostics.push({
        name: outcome.name, scope, priority: outcome.priority, source,
        decision: outcome.decision as SkillDiagnosticDecision, reason: outcome.reason,
      });
      continue;
    }
    const ref = resolveSkillRef(outcome.name, rows, agentId);
    if (ref.kind === "resolved") {
      skills.push({ name: outcome.name, skillId: ref.skillId, scope, priority: outcome.priority, source });
      continue;
    }
    diagnostics.push({
      name: outcome.name, scope, priority: outcome.priority, source, decision: ref.kind, reason: ref.reason,
      ...(ref.kind === "ambiguous" ? { candidates: ref.candidates } : {}),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  diagnostics.sort(compareDiagnostics);
  return { skills, diagnostics };
}
