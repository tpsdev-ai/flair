/**
 * Classify a catchup OrgEvent as a directed dispatch this runner may wake on,
 * and project the light payload (pointer + one-line brief) into a Cursor prompt.
 */

export const DISPATCH_KINDS = ["coord.dispatch", "a2a.message"] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

export interface OrgEventLike {
  id?: unknown;
  kind?: unknown;
  summary?: unknown;
  detail?: unknown;
  targetIds?: unknown;
  refId?: unknown;
  authorId?: unknown;
  position?: unknown;
  entities?: unknown;
}

export interface DirectedDispatch {
  id: string;
  kind: DispatchKind;
  summary: string;
  detail: string | null;
  authorId: string | null;
  position: string | null;
  targetIds: string[];
  pointer: string | null;
  repoUrl: string | null;
  prUrl: string | null;
}

const KIND_SET = new Set<string>(DISPATCH_KINDS);

const GITHUB_URL =
  /(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(issues|pull)\/(\d+))?/i;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function isDispatchKind(kind: unknown): kind is DispatchKind {
  return typeof kind === "string" && KIND_SET.has(kind);
}

/**
 * Directed only: `targetIds` must include this agent. Broadcasts (empty /
 * missing targetIds) are org activity, not a wake. Catchup already filters
 * the feed; this is the runner's second gate so a broadcast `coord.dispatch`
 * cannot start a crew agent.
 */
export function isDirectedAt(event: OrgEventLike, agentId: string): boolean {
  const targets = asStringList(event.targetIds);
  return targets.includes(agentId);
}

export function extractPointer(event: OrgEventLike): {
  pointer: string | null;
  repoUrl: string | null;
  prUrl: string | null;
} {
  const candidates = [
    asString(event.refId),
    asString(event.detail),
    asString(event.summary),
    ...asStringList(event.entities),
  ].filter((value): value is string => value !== null);

  let pointer: string | null = asString(event.refId);
  let repoUrl: string | null = null;
  let prUrl: string | null = null;

  for (const text of candidates) {
    const match = text.match(GITHUB_URL);
    if (!match) continue;
    const owner = match[1];
    const repo = match[2];
    const kind = match[3]?.toLowerCase();
    const number = match[4];
    repoUrl = `https://github.com/${owner}/${repo}`;
    const href = kind && number ? `${repoUrl}/${kind === "pull" ? "pull" : "issues"}/${number}` : repoUrl;
    if (kind === "pull" && number) prUrl = href;
    pointer = pointer ?? href;
    break;
  }

  if (!pointer) {
    for (const text of candidates) {
      const url = text.match(/https?:\/\/\S+/);
      if (url) {
        pointer = url[0].replace(/[),.;]+$/, "");
        break;
      }
    }
  }

  return { pointer, repoUrl, prUrl };
}

export function classifyDispatch(event: OrgEventLike, agentId: string): DirectedDispatch | null {
  if (!isDispatchKind(event.kind)) return null;
  if (!isDirectedAt(event, agentId)) return null;
  const id = asString(event.id);
  if (!id) return null;
  const { pointer, repoUrl, prUrl } = extractPointer(event);
  return {
    id,
    kind: event.kind,
    summary: asString(event.summary) ?? "",
    detail: asString(event.detail),
    authorId: asString(event.authorId),
    position: asString(event.position),
    targetIds: asStringList(event.targetIds),
    pointer,
    repoUrl,
    prUrl,
  };
}

export function buildWakePrompt(dispatch: DirectedDispatch, crewAgentId: string): string {
  const pointer = dispatch.pointer ?? "(no pointer — use the brief only)";
  const detail = dispatch.detail ? `\nDetail: ${dispatch.detail}` : "";
  return [
    `You were dispatched by a Flair OrgEvent (${dispatch.kind}) to crew agent "${crewAgentId}".`,
    `Brief: ${dispatch.summary || "(none)"}`,
    `Pointer: ${pointer}`,
    detail.trim(),
    "",
    "The event is light on purpose. The heavy spec lives at the pointer (GitHub issue/PR or Beads id).",
    "Do that work. Do not rebuild a message board or use shared memory as a queue.",
    "When you start, you may publish flair_orgevent kind=coord.ack (or coord.building) with a one-line status.",
    `When you finish, publish flair_orgevent kind=coord.done (or coord.blocked) referencing the same pointer.`,
    `OrgEvent id: ${dispatch.id}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildWakeName(dispatch: DirectedDispatch): string {
  const raw = dispatch.summary || dispatch.pointer || dispatch.id;
  const name = `wake: ${raw}`.slice(0, 100);
  return name;
}
