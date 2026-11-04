/**
 * instruction-event-doctor.ts — the `flair doctor` check for stored OrgEvents
 * that carry a reserved marker but fail the reader rule
 * (flair#2139 slice 3a).
 *
 * Main never refused reserved kinds or the `instruction-change:` id prefix, so
 * a store may already hold rows that were written through the operations API.
 * The reader rule is: the id carries the prefix, the kind is a reserved kind,
 * the refId names an existing InstructionVersion, that version's id is the
 * event id's suffix, and its subject type matches the kind.
 *
 * The decision is pure; the reads use the operations API and return null on a
 * failed read (never an empty list).
 */

import { RESERVED_EVENT_ID_PREFIX, RESERVED_EVENT_KINDS, isReservedEventRecord } from "./instruction-event-contract.js";

export const INSTRUCTION_EVENT_ROWS_SQL = "SELECT id, kind, refId FROM flair.OrgEvent";
export const INSTRUCTION_VERSION_ROWS_SQL = "SELECT id, subjectType FROM flair.InstructionVersion";

export interface InstructionEventRow { id?: unknown; kind?: unknown; refId?: unknown }
export interface InstructionVersionRow { id?: unknown; subjectType?: unknown }

const KIND_SUBJECT: Readonly<Record<string, string>> = Object.freeze({
  "soul.changed": "soul",
  "skill.changed": "skill",
});

function instructionEventReaderFailure(
  event: InstructionEventRow,
  version: InstructionVersionRow | undefined,
): string | null {
  const id = event.id;
  const kind = event.kind;
  if (typeof id !== "string" || !id.startsWith(RESERVED_EVENT_ID_PREFIX)) return "missing prefix";
  if (typeof kind !== "string" || !RESERVED_EVENT_KINDS.includes(kind)) return "kind mismatch";
  if (!version || typeof version.id !== "string") return "no matching version";
  if (version.id !== id.slice(RESERVED_EVENT_ID_PREFIX.length)) return "suffix mismatch";
  if (version.subjectType !== KIND_SUBJECT[kind]) return "kind mismatch";
  return null;
}

/** Whether a stored event satisfies the reader rule. */
export function instructionEventSatisfiesReaderRule(
  event: InstructionEventRow,
  version: InstructionVersionRow | undefined,
): boolean {
  return instructionEventReaderFailure(event, version) === null;
}

/**
 * Every stored event that carries a reserved marker but fails the reader rule,
 * sorted by id. An event with neither marker is not an impostor.
 */
function findInstructionEventFailures(
  events: readonly InstructionEventRow[],
  versions: readonly InstructionVersionRow[],
): Array<{ id: string; reason: string }> {
  const byId = new Map<string, InstructionVersionRow>();
  for (const version of versions) {
    if (typeof version.id === "string") byId.set(version.id, version);
  }
  const impostors: Array<{ id: string; reason: string }> = [];
  for (const event of events) {
    const id = event.id;
    if (!isReservedEventRecord(event)) continue;
    const version = typeof event.refId === "string" ? byId.get(event.refId) : undefined;
    const reason = instructionEventReaderFailure(event, version);
    if (reason) {
      impostors.push({ id: typeof id === "string" && id.length > 0 ? id : "(no id)", reason });
    }
  }
  return impostors.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function findInstructionEventImpostors(
  events: readonly InstructionEventRow[],
  versions: readonly InstructionVersionRow[],
): string[] {
  return findInstructionEventFailures(events, versions).map(({ id }) => id);
}

/** The doctor line for a stored impostor set: null when the store is clean. */
export function describeInstructionEventImpostors(
  events: readonly InstructionEventRow[],
  versions: readonly InstructionVersionRow[],
): string | null {
  const impostors = findInstructionEventFailures(events, versions);
  if (impostors.length === 0) return null;
  return `${impostors.length} stored OrgEvent ${impostors.length === 1 ? "row carries" : "rows carry"} a reserved kind or id but ${impostors.length === 1 ? "fails" : "fail"} the instruction-event reader rule: ${impostors.map(({ id, reason }) => `${id} (${reason})`).join(", ")}`;
}

/** Read both tables through the ops API; null when either read fails. */
export async function readInstructionEventTables(args: {
  opsUrl: string;
  authHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ events: InstructionEventRow[]; versions: InstructionVersionRow[] } | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const read = async (sql: string): Promise<unknown[] | null> => {
    try {
      const res = await fetchImpl(args.opsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: args.authHeader },
        body: JSON.stringify({ operation: "sql", sql }),
        signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : Array.isArray((data as any)?.results) ? (data as any).results : null;
    } catch {
      return null;
    }
  };
  const events = await read(INSTRUCTION_EVENT_ROWS_SQL);
  const versions = await read(INSTRUCTION_VERSION_ROWS_SQL);
  if (events === null || versions === null) return null;
  return {
    events: events as InstructionEventRow[],
    versions: versions as InstructionVersionRow[],
  };
}
