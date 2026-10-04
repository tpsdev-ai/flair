/** What init could read about the process holding one specific port. */
export interface OccupiedHarperListener {
  /** The port this attribution was read from. */
  port: number;
  /**
   * PIDs from this one read. The pre-auth message names a pid only when
   * this list has exactly one entry. An operations-port 401 names a pid
   * only when the read before the insert and the read after the 401 agree
   * on that same sole PID.
   */
  pids: number[];
  /**
   * ROOTPATH values actually read from those pids. Empty when the lookup
   * could not read a directory — that is not a foreign data directory.
   */
  dataDirs: string[];
  /**
   * Whether the pid lookup returned an array. False means it returned null.
   */
  pidsKnown?: boolean;
}

/** Pid list and ROOTPATH reads for one observation. Tests inject both. */
export interface OccupiedListenerLookup {
  pids(port: number): number[] | null;
  rootPath(pid: number): { rootPath: string | null; environReadable: boolean };
}

/**
 * One observation of who is listening. An unreadable ROOTPATH is omitted,
 * so it cannot become a pre-auth refusal. Does not decide `flair stop`.
 */
export function listenerFromLookup(port: number, lookup: OccupiedListenerLookup): OccupiedHarperListener {
  const read = lookup.pids(port);
  const pids = read ?? [];
  const dataDirs: string[] = [];
  for (const pid of pids) {
    const root = lookup.rootPath(pid);
    if (root.environReadable && root.rootPath && !dataDirs.includes(root.rootPath)) dataDirs.push(root.rootPath);
  }
  return { port, pids, dataDirs, pidsKnown: read !== null };
}

/**
 * Snapshot taken before an operations insert, plus a second read used only
 * if that insert returns 401. The two reads are how a holder that changed
 * during the request is detected — comparing the first list with itself is not.
 */
export interface OperationsPortAttribution {
  before: OccupiedHarperListener;
  reread: () => OccupiedHarperListener;
}

/**
 * The process a 401 can be tied to.
 *
 * One pid, the same sole PID on both sides of the insert: that holder. Zero
 * pids, several pids, or a different pid after the 401: nobody. The
 * fallback does not keep data directories from a set of processes the 401
 * was not tied to. This is not the pre-auth observation, which is one read.
 */
export function stableAnsweredHolder(
  before: OccupiedHarperListener,
  after: OccupiedHarperListener,
): OccupiedHarperListener {
  const sameSingle =
    before.pids.length === 1 &&
    after.pids.length === 1 &&
    before.pids[0] === after.pids[0];
  if (!sameSingle) {
    return { port: after.port, pids: [], dataDirs: [], pidsKnown: after.pidsKnown };
  }
  return {
    port: after.port,
    pids: [after.pids[0]],
    dataDirs: after.dataDirs,
    pidsKnown: after.pidsKnown,
  };
}

export function foreignOccupiedListenerDetail(listener: OccupiedHarperListener): string {
  const lines: string[] = [];
  appendRemedy(lines, listener);
  return lines.join("\n");
}

export function occupiedListenerAuthFailure(input: {
  /** Existing status lead, including the trailing space before the body. */
  lead: string;
  /** Response body, preserved so the server's own words stay visible. */
  bodyText: string;
  listener: OccupiedHarperListener;
}): string {
  const pid = input.listener.pids.length === 1 ? `, pid ${input.listener.pids[0]}` : "";
  const lines = [
    `${input.lead}${input.bodyText}`,
    `  Port ${input.listener.port}${pid}: admin authentication failed.`,
  ];
  lines.push("Remedy: check the admin password for this data directory, then rerun init.");
  return lines.join("\n");
}

/**
 * `kill` only for the one pid this message named. `flair stop` cannot be
 * promised to act on this listener.
 */
function appendRemedy(lines: string[], listener: OccupiedHarperListener): void {
  lines.push("Remedy: free the port or choose --port and --ops-port, then rerun init.");
  if (listener.pids.length === 1) lines.push(`  kill ${listener.pids[0]}`);
  for (const dir of listener.dataDirs) {
    lines.push(`  flair init --data-dir ${commandArg(dir)}`);
  }
}

/** Quote a path that would split on the shell. Numbers and plain paths stay bare. */
export function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
