/**
 * skill-manifest.ts — the structured skills manifest in every successful
 * bootstrap response (flair#2141 S1b, S1). No Harper imports.
 *
 * `resolveSkillManifest` turns an agent's `skill-assignment` Soul rows and the
 * instance's org-scope assignments (OrgSkillAssignment) into two lists:
 *   - `skills`: the winners only — `{ name, skillId, scope, priority, source }`,
 *     where `skillId` is the skill-tagged Memory row to fetch with `skill_get`.
 *   - `diagnostics`: assignments refused (a non-durable source, an
 *     equal-priority tie or a non-boolean `optOut`) or superseded, and winners
 *     whose skill row does not resolve (unresolved or ambiguous).
 * Candidates are the agent's own assignments (scope "own") plus the org
 * assignments (scope "org") whose names the agent is not opted out of. The
 * priority/tie rules (`resolveActiveSkills`, skill-provenance.ts) run on the
 * candidates; then each winner's skill row is resolved: an own name to the
 * agent's own skill row, an org assignment to its `skillRef`.
 *
 * The manifest strings (`name`, `source`) come from Soul `skill-assignment`
 * rows, and an org entry's `name` from its OrgSkillAssignment row; they reach
 * the agent's context without SkillScan. That is safe only because no agent
 * key can write those rows; only operator credentials and Flair's own internal
 * paths can (resources/soul-write-policy.ts, resources/OrgSkillAssignment.ts).
 * Widening who may write them changes this render path.
 */

import {
  formatBase,
  normalizePriority,
  parseSkillMetadata,
  resolveActiveSkills,
  skillSourceOf,
  type SkillAssignmentInput,
} from "./skill-provenance.js";
import { isSkillWrite } from "./skill-write.js";

export type SkillScope = "own" | "org";

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
  /** Ambiguous only: the ids of the agent's own skill rows with the name. */
  candidates?: string[];
}

/** A skill-tagged Memory row, as far as name resolution reads it. */
export interface SkillRow {
  id?: unknown;
  agentId?: unknown;
  tags?: unknown;
  metadata?: unknown;
  archived?: unknown;
  validTo?: unknown;
  expiresAt?: unknown;
}

/** The Memory fields the bootstrap skill-row query selects. */
export const SKILL_ROW_SELECT = [
  "id", "agentId", "visibility", "tags", "metadata", "archived", "validTo", "expiresAt",
];

export type SkillRefResolution =
  | { kind: "resolved"; skillId: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "ambiguous"; reason: string; candidates: string[] };

/** A `skill-assignment` Soul row, as far as the manifest reads it. */
export type OwnSkillAssignment = SkillAssignmentInput & { originatorInstanceId?: unknown };

/** An OrgSkillAssignment row, as far as the manifest reads it. */
export interface OrgSkillAssignmentRow {
  skillName?: unknown;
  skillRef?: unknown;
  priority?: unknown;
}

export interface OrgSkillInput {
  /** The OrgSkillAssignment rows; empty when the target does not receive org skills. */
  assignments: OrgSkillAssignmentRow[];
  /** The rows the `skillRef`s name, already passed through resolvableSkillRows. */
  rows: SkillRow[];
  /** This instance's id, or null when it has none. An opt-out applies only
   *  when its Soul row's `originatorInstanceId` equals it. */
  instanceId: string | null;
}

const NO_ORG: OrgSkillInput = { assignments: [], rows: [], instanceId: null };

/**
 * Whether a target receives org skills, from its Agent record: the record
 * exists, `kind` is "agent" (absent counts as "agent") and `status` is
 * "active" (absent counts as "active").
 */
export function receivesOrgSkills(agent: unknown): boolean {
  if (!agent || typeof agent !== "object") return false;
  const { kind, status } = agent as { kind?: unknown; status?: unknown };
  return (kind ?? "agent") === "agent" && (status ?? "active") === "active";
}

/** A skill row's name: `metadata.name` (skill_store folds it there). */
export function skillNameOf(row: SkillRow): string | undefined {
  const name = parseSkillMetadata(row.metadata).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function isPast(value: unknown, now: number): boolean {
  return typeof value === "string" && value.length > 0 && Date.parse(value) < now;
}

/**
 * The rows passed to resolveSkillRef: skill-tagged, readable by the target agent
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
 * flair#2141 S2 hook: the skill rows written by the reserved system writer
 * (the operator seed), the only candidates besides the agent's own rows. None
 * exist before S2, so this returns no rows.
 */
export function seedSkillRows(_rows: SkillRow[]): SkillRow[] {
  return [];
}

/**
 * Resolve a name-only assignment to one skill row: the target agent's own row
 * with that name (then, from flair#2141 S2, a seed row; see seedSkillRows).
 * More than one row at a step is ambiguous; no row is unresolved.
 */
export function resolveSkillRef(name: string, rows: SkillRow[], agentId: string): SkillRefResolution {
  const named = rows.filter((row) => skillNameOf(row) === name);
  const decide = (list: SkillRow[], whose: string): SkillRefResolution | null => {
    if (list.length === 1) return { kind: "resolved", skillId: list[0].id as string };
    if (list.length === 0) return null;
    return {
      kind: "ambiguous",
      reason: `${list.length} ${whose} skill rows have this name`,
      candidates: list.map((row) => row.id as string).sort(),
    };
  };
  return decide(named.filter((row) => row.agentId === agentId), "of the agent's own")
    ?? decide(seedSkillRows(named), "seed")
    ?? { kind: "unresolved", reason: "the agent has no live skill row with this name" };
}

/** An org assignment's `skillRef`, resolved against the rows it may name. */
function resolveOrgRef(skillRef: unknown, rows: SkillRow[]): SkillRefResolution {
  if (typeof skillRef === "string" && rows.some((row) => row.id === skillRef)) {
    return { kind: "resolved", skillId: skillRef };
  }
  return { kind: "unresolved", reason: "the skillRef is not a live skill row this agent can read" };
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
    || a.reason.localeCompare(b.reason)
    || a.scope.localeCompare(b.scope);
}

type Candidate = { input: SkillAssignmentInput; scope: SkillScope; skillRef?: unknown };

/**
 * The manifest for one agent: `assignments` are its `skill-assignment` Soul
 * rows, `rows` the skill rows its own names may resolve to (see
 * resolvableSkillRows), `org` the org assignments it receives. A Soul row with
 * `metadata.optOut: true` is an opt-out, never a candidate: it removes the org
 * assignments with that name before the priority rules, when its
 * `originatorInstanceId` is `org.instanceId`. `skills` is sorted by name;
 * `diagnostics` by name, decision, source, priority, reason and scope.
 */
export function resolveSkillManifest(
  assignments: OwnSkillAssignment[],
  rows: SkillRow[],
  agentId: string,
  org: OrgSkillInput = NO_ORG,
): { skills: SkillManifestEntry[]; diagnostics: SkillDiagnostic[] } {
  const skills: SkillManifestEntry[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const candidates: Candidate[] = [];
  const optedOut = new Set<string>();

  for (const assignment of assignments) {
    const optOut = parseSkillMetadata(assignment.metadata).optOut;
    if (optOut === undefined || optOut === false) {
      candidates.push({ input: assignment, scope: "own" });
      continue;
    }
    if (typeof assignment.value !== "string" || assignment.value.length === 0) continue;
    if (optOut !== true) {
      diagnostics.push({
        name: assignment.value, scope: "own",
        priority: normalizePriority(assignment.priority),
        source: skillSourceOf(assignment) ?? null,
        decision: "refused", reason: "metadata.optOut is not a boolean",
      });
      continue;
    }
    if ((assignment.originatorInstanceId ?? null) === org.instanceId) optedOut.add(assignment.value);
  }
  for (const row of org.assignments) {
    if (typeof row.skillName !== "string" || optedOut.has(row.skillName)) continue;
    candidates.push({ input: { value: row.skillName, priority: row.priority }, scope: "org", skillRef: row.skillRef });
  }

  const byInput = new Map(candidates.map((candidate) => [candidate.input, candidate]));
  for (const outcome of resolveActiveSkills(candidates.map((candidate) => candidate.input)).outcomes) {
    const candidate = byInput.get(outcome.input) as Candidate;
    const scope = candidate.scope;
    const source = outcome.source ?? null;
    if (!outcome.loaded) {
      diagnostics.push({
        name: outcome.name, scope, priority: outcome.priority, source,
        decision: outcome.decision as SkillDiagnosticDecision, reason: outcome.reason,
      });
      continue;
    }
    const ref = scope === "org"
      ? resolveOrgRef(candidate.skillRef, org.rows)
      : resolveSkillRef(outcome.name, rows, agentId);
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
