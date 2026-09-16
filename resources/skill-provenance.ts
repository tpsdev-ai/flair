/**
 * skill-provenance.ts — durable source + stated conflict outcome (flair#1433).
 *
 * Two defects, two functions, no Harper imports:
 *
 *   1. Registration: a skill-assignment (Soul key `skill-assignment`) whose
 *      `metadata.source` is a filesystem path under a temp directory is not
 *      provenance. `registerSkillAssignment` / `refuseSkillAssignmentWrite`
 *      fail and name the path. Scratch/inspect paths (`/tmp/...-inspect/...`)
 *      are the known-answer case from the 2026-08-26 flint bootstrap payload.
 *
 *   2. Load: `SKILL_CONFLICT` must decide something. Skills are identified by
 *      `value` (name). Priority is stated precedence (critical > high >
 *      standard > low). A unique highest priority loads; an equal-priority
 *      tie refuses the whole name-set. Map iteration order never picks a
 *      winner. The payload line states the decision and why.
 *
 * Trust/signature is out of scope (epic #1434, later). This module does not
 * invent a signing model.
 *
 * A normally-installed, non-conflicting skill with a durable (or absent)
 * source still loads silently — no marker.
 */

import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ASSIGNMENT_KEY = "skill-assignment";

export const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  standard: 2,
  low: 3,
};

export type SkillRegistrationOk = { ok: true };
export type SkillRegistrationRefused = {
  ok: false;
  error: "skill_source_not_durable";
  path: string;
  message: string;
};
export type SkillRegistrationResult = SkillRegistrationOk | SkillRegistrationRefused;

export type SkillAssignmentInput = {
  key?: unknown;
  value?: unknown;
  priority?: unknown;
  metadata?: unknown;
};

export type SkillDecision = "loaded" | "superseded" | "refused";

export type SkillOutcome = {
  name: string;
  priority: string;
  source?: string;
  decision: SkillDecision;
  reason: string;
  loaded: boolean;
  line: string;
};

export function parseSkillMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata === "string" && metadata.length > 0) {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* opaque / corrupt blob — no source */
    }
  }
  return {};
}

export function skillSourceOf(record: { metadata?: unknown }): string | undefined {
  const src = parseSkillMetadata(record.metadata).source;
  return typeof src === "string" && src.trim().length > 0 ? src.trim() : undefined;
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function isWindowsDrivePath(source: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(source);
}

/**
 * If `source` names a filesystem path (absolute, relative, or `file:` URL),
 * return that path. Scheme-bearing identifiers (`npm:`, `https:`, …) are
 * not filesystem paths. A bare name is not a path.
 */
export function filesystemPathFromSkillSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file:")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      const rest = trimmed.replace(/^file:\/\//, "").replace(/^file:/, "");
      return rest.length > 0 ? rest : null;
    }
  }

  if (SCHEME.test(trimmed) && !isWindowsDrivePath(trimmed)) return null;

  if (isAbsolute(trimmed) || trimmed.startsWith(".") || /[\\/]/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function tempRoots(): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p || typeof p !== "string" || p.length === 0) return;
    try {
      roots.add(resolve(p));
    } catch {
      /* ignore unresolvable */
    }
  };
  add(tmpdir());
  add("/tmp");
  add("/private/tmp");
  add("/var/tmp");
  add(process.env.TMPDIR);
  add(process.env.TMP);
  add(process.env.TEMP);
  return [...roots];
}

export function isNonDurableFilesystemPath(fsPath: string): boolean {
  let resolved: string;
  try {
    resolved = resolve(fsPath);
  } catch {
    return true;
  }
  for (const root of tempRoots()) {
    if (resolved === root || resolved.startsWith(root + sep)) return true;
  }
  return false;
}

export function isDurableSkillSource(source: string): boolean {
  const fsPath = filesystemPathFromSkillSource(source);
  if (fsPath == null) return true;
  return !isNonDurableFilesystemPath(fsPath);
}

export function registerSkillAssignment(input: SkillAssignmentInput): SkillRegistrationResult {
  const key = typeof input.key === "string" ? input.key : SKILL_ASSIGNMENT_KEY;
  if (key !== SKILL_ASSIGNMENT_KEY) return { ok: true };
  const source = skillSourceOf(input);
  if (!source) return { ok: true };
  if (isDurableSkillSource(source)) return { ok: true };
  return {
    ok: false,
    error: "skill_source_not_durable",
    path: source,
    message: `skill source is not durable: ${source}`,
  };
}

export function refuseNonDurableSourceResponse(source: string | undefined): Response | null {
  if (!source) return null;
  if (isDurableSkillSource(source)) return null;
  return new Response(
    JSON.stringify({
      error: "skill_source_not_durable",
      path: source,
      message: `skill source is not durable: ${source}`,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function assignmentKey(content: any, existing?: any): string | undefined {
  const key = content?.key ?? existing?.key;
  return typeof key === "string" ? key : undefined;
}

/** Soul post/put/patch gate. `existing` supplies omitted fields on PATCH. */
export function refuseSkillAssignmentWrite(content: any, existing?: any): Response | null {
  if (assignmentKey(content, existing) !== SKILL_ASSIGNMENT_KEY) return null;
  const metadata = content?.metadata !== undefined ? content.metadata : existing?.metadata;
  const result = registerSkillAssignment({
    key: SKILL_ASSIGNMENT_KEY,
    value: content?.value ?? existing?.value,
    priority: content?.priority ?? existing?.priority,
    metadata,
  });
  if (result.ok) return null;
  return new Response(
    JSON.stringify({
      error: result.error,
      path: result.path,
      message: result.message,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function normalizePriority(p: unknown): string {
  if (typeof p === "string" && Object.hasOwn(PRIORITY_RANK, p)) return p;
  return "standard";
}

function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? PRIORITY_RANK.standard;
}

function formatBase(name: string, priority: string, source: string | undefined): string {
  const src = source ? `, source: ${source}` : "";
  return `- ${name} (${priority} priority${src})`;
}

function compareOutcomes(a: SkillOutcome, b: SkillOutcome): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  const bySource = (a.source ?? "").localeCompare(b.source ?? "");
  if (bySource !== 0) return bySource;
  const byPri = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPri !== 0) return byPri;
  return a.reason.localeCompare(b.reason);
}

function outcomeOf(
  name: string,
  priority: string,
  source: string | undefined,
  decision: SkillDecision,
  reason: string,
  loaded: boolean,
): SkillOutcome {
  let line = formatBase(name, priority, source);
  if (decision === "superseded") {
    line += ` [SKILL_CONFLICT superseded: ${reason}]`;
  } else if (decision === "refused") {
    line += reason.startsWith("non-durable source")
      ? ` [refused: ${reason}]`
      : ` [SKILL_CONFLICT refused: ${reason}]`;
  }
  return { name, priority, source, decision, reason, loaded, line };
}

/**
 * Stated, deterministic Active Skills outcome.
 *
 * Identity is `value` (name). Two different names at the same priority are
 * not a conflict — they are two skills. Two records of the same name:
 * unique highest priority wins (stated); an equal-priority tie refuses
 * every member of that name-set. Non-durable sources are refused at load
 * as well as at registration so a scratch path already on disk cannot
 * keep applying.
 *
 * Output order is name → source → priority → reason, so a restart with
 * the same records produces the same lines regardless of input order.
 */
export function resolveActiveSkills(assignments: SkillAssignmentInput[]): {
  lines: string[];
  outcomes: SkillOutcome[];
} {
  const prepared: Array<{
    name: string;
    priority: string;
    source: string | undefined;
  }> = [];
  const outcomes: SkillOutcome[] = [];

  for (const raw of assignments) {
    const name = typeof raw.value === "string" ? raw.value : "";
    if (name.length === 0) continue;
    const priority = normalizePriority(raw.priority);
    const source = skillSourceOf(raw);
    if (source && !isDurableSkillSource(source)) {
      outcomes.push(outcomeOf(name, priority, source, "refused", `non-durable source ${source}`, false));
      continue;
    }
    prepared.push({ name, priority, source });
  }

  const byName = new Map<string, typeof prepared>();
  for (const row of prepared) {
    const list = byName.get(row.name);
    if (list) list.push(row);
    else byName.set(row.name, [row]);
  }

  for (const group of byName.values()) {
    if (group.length === 1) {
      const only = group[0];
      outcomes.push(outcomeOf(only.name, only.priority, only.source, "loaded", "sole", true));
      continue;
    }
    const best = Math.min(...group.map((g) => priorityRank(g.priority)));
    const top = group.filter((g) => priorityRank(g.priority) === best);
    if (top.length === 1) {
      const winner = top[0];
      outcomes.push(outcomeOf(
        winner.name,
        winner.priority,
        winner.source,
        "loaded",
        `unique_priority ${winner.priority}`,
        true,
      ));
      for (const loser of group) {
        if (loser === winner) continue;
        outcomes.push(outcomeOf(
          loser.name,
          loser.priority,
          loser.source,
          "superseded",
          `${winner.priority} priority is stated precedence over ${loser.priority}`,
          false,
        ));
      }
      continue;
    }
    const sources = [...new Set(top.map((t) => t.source ?? "(none)"))].sort((a, b) => a.localeCompare(b));
    const reason =
      `equal-priority tie at ${top[0].priority}; load refused (sources: ${sources.join(", ")})`;
    for (const member of group) {
      outcomes.push(outcomeOf(member.name, member.priority, member.source, "refused", reason, false));
    }
  }

  outcomes.sort(compareOutcomes);
  return { lines: outcomes.map((o) => o.line), outcomes };
}
