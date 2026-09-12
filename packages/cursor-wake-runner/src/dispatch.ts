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

/** Bound OrgEvent-derived text before scanning so a hostile detail cannot hang. */
const POINTER_SCAN_MAX = 2048;

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

function isOwnerChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 46 ||
    code === 95
  );
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function clip(text: string): string {
  return text.length > POINTER_SCAN_MAX ? text.slice(0, POINTER_SCAN_MAX) : text;
}

function indexOfCi(hay: string, needle: string): number {
  return hay.toLowerCase().indexOf(needle);
}

/**
 * Linear GitHub URL / path scan — no backtracking regex on OrgEvent text.
 * Accepts optional http(s):// and owner/repo[/issues|pull/N].
 */
export function parseGitHubRef(text: string): {
  pointer: string;
  repoUrl: string;
  prUrl: string | null;
} | null {
  const hay = clip(text);
  const at = indexOfCi(hay, "github.com/");
  if (at < 0) return null;
  let i = at + "github.com/".length;
  const ownerStart = i;
  while (i < hay.length && isOwnerChar(hay.charCodeAt(i))) i += 1;
  if (i === ownerStart || hay[i] !== "/") return null;
  const owner = hay.slice(ownerStart, i);
  i += 1;
  const repoStart = i;
  while (i < hay.length && isOwnerChar(hay.charCodeAt(i))) i += 1;
  if (i === repoStart) return null;
  let repo = hay.slice(repoStart, i);
  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  const repoUrl = `https://github.com/${owner}/${repo}`;
  let pointer = repoUrl;
  let prUrl: string | null = null;
  if (hay[i] === "/") {
    i += 1;
    const kindStart = i;
    while (i < hay.length && isAlpha(hay.charCodeAt(i))) i += 1;
    const kind = hay.slice(kindStart, i).toLowerCase();
    if ((kind === "issues" || kind === "pull") && hay[i] === "/") {
      i += 1;
      const numStart = i;
      while (i < hay.length && isDigit(hay.charCodeAt(i))) i += 1;
      if (i > numStart) {
        const n = hay.slice(numStart, i);
        pointer = `${repoUrl}/${kind === "pull" ? "pull" : "issues"}/${n}`;
        if (kind === "pull") prUrl = pointer;
      }
    }
  }
  return { pointer, repoUrl, prUrl };
}

/**
 * First http(s) URL in `text`, linear scan. Trailing `) , . ;` stripped with
 * a while-loop — not a regex — so a long run of `)` cannot backtrack.
 */
export function firstHttpUrl(text: string): string | null {
  const hay = clip(text);
  const lower = hay.toLowerCase();
  const httpsAt = lower.indexOf("https://");
  const httpAt = lower.indexOf("http://");
  let start = -1;
  if (httpsAt >= 0 && httpAt >= 0) start = Math.min(httpsAt, httpAt);
  else start = httpsAt >= 0 ? httpsAt : httpAt;
  if (start < 0) return null;
  let end = start;
  while (end < hay.length && hay.charCodeAt(end) > 32) end += 1;
  let url = hay.slice(start, end);
  while (url.length > 0) {
    const last = url.charCodeAt(url.length - 1);
    if (last === 41 || last === 44 || last === 46 || last === 59) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  const scheme = url.slice(0, 8).toLowerCase();
  if (scheme !== "https://" && url.slice(0, 7).toLowerCase() !== "http://") return null;
  return url;
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
    const gh = parseGitHubRef(text);
    if (!gh) continue;
    repoUrl = gh.repoUrl;
    prUrl = gh.prUrl;
    pointer = pointer ?? gh.pointer;
    break;
  }

  if (!pointer) {
    for (const text of candidates) {
      const url = firstHttpUrl(text);
      if (url) {
        pointer = url;
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
