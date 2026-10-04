/**
 * init-occupied-listener.ts — flair#1749
 *
 * `flair init` used to treat "something already answered /health" as "our
 * Harper is up", skip its own start, and then explain an operations-API 401
 * as a wrong `--admin-pass`. Two claims that message must not make:
 *
 * - A different data directory does not prove the admin passwords differ.
 * - The process holding the HTTP port is not necessarily the one that
 *   rejected an operations-port request. Those ports are resolved separately
 *   and can have different owners.
 *
 * Init can name a different data directory only when that one read could
 * read one. An unreadable ROOTPATH is not proof of a foreign instance.
 * On macOS the directory is unavailable, so init does not refuse before
 * auth from a parsed ROOTPATH.
 *
 * That pre-auth observation is a single read. It is not the operations-port
 * 401 check. A 401 names a pid only when the read before the insert and the
 * read after the 401 are the same sole PID. Several holders, or a holder
 * that changed during the request, stay "a Harper instance this init did
 * not start".
 *
 * These messages do not offer `flair stop`. `flair stop` cannot be promised
 * to act on this listener. The remedy is `kill <pid>` when one process is
 * named. Init never signals a process it did not start.
 */
import { canonicalLexicalPath } from "./daemon-liveness.js";

/** What init could read about the process holding one specific port. */
export interface OccupiedHarperListener {
  /** The port this attribution was read from — the port that answered. */
  port: number;
  /**
   * PIDs from this one read. The pre-auth message names a pid only when
   * this list has exactly one entry. An operations-port 401 names a pid
   * only when the read before the insert and the read after the 401 agree
   * on that same sole PID. Empty, or more than one, is the unattributed
   * fallback: do not suggest `kill` for every pid in the list.
   */
  pids: number[];
  /**
   * ROOTPATH values actually read from those pids. Empty when the lookup
   * could not read a directory — that is not a foreign data directory.
   */
  dataDirs: string[];
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
  const pids = lookup.pids(port) ?? [];
  const dataDirs: string[] = [];
  for (const pid of pids) {
    const read = lookup.rootPath(pid);
    if (read.environReadable && read.rootPath && !dataDirs.includes(read.rootPath)) dataDirs.push(read.rootPath);
  }
  return { port, pids, dataDirs };
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
    return { port: after.port, pids: [], dataDirs: [] };
  }
  return {
    port: after.port,
    pids: [after.pids[0]],
    dataDirs: after.dataDirs,
  };
}

const UNATTRIBUTED = "a Harper instance this init did not start";

/**
 * Name the listener for an operator. A pid is included only when exactly one
 * was read — several holders are not a kill list. Pid and data directory
 * when both were read; whichever was read, plus the fallback phrase, when
 * only one was; the fallback phrase alone when neither was.
 */
export function describeOccupiedListener(listener: Pick<OccupiedHarperListener, "pids" | "dataDirs">): string {
  const pid = listener.pids.length === 1 ? `pid ${listener.pids[0]}` : null;
  const dir = listener.dataDirs.length > 0 ? `data dir ${listener.dataDirs.join(", ")}` : null;
  if (pid && dir) return `${pid}, ${dir}`;
  if (pid || dir) return `${pid ?? dir} (${UNATTRIBUTED})`;
  return UNATTRIBUTED;
}

/** Sentence carried wherever a different directory might be misread as a password fact. */
export const DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD =
  "A different data directory does not prove the admin passwords differ.";

/** Sentence carried on an operations-port rejection. The HTTP holder is a different fact. */
export const HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT =
  "The process holding the HTTP port is not necessarily the one that rejected the operations request.";

function foreignDataDirs(expectedDataDir: string, dataDirs: readonly string[]): string[] {
  const expected = canonicalLexicalPath(expectedDataDir);
  return dataDirs.filter((dir) => canonicalLexicalPath(dir) !== expected);
}

/**
 * Printed from the single pre-auth read of the HTTP listener, when that
 * read included a ROOTPATH other than this init's data directory. Init
 * exits on it — before the authenticated health request and before the
 * operations insert. This is not the before-and-after 401 attribution.
 * A different directory is not proof the passwords differ. Returns null
 * when the directory matches or could not be read: an unreadable lookup
 * is not a foreign instance.
 */
export function staleHarperBeforeAuthNotice(
  expectedDataDir: string,
  listener: OccupiedHarperListener,
): string | null {
  const foreign = foreignDataDirs(expectedDataDir, listener.dataDirs);
  if (foreign.length === 0) return null;
  const who = describeOccupiedListener({ pids: listener.pids, dataDirs: foreign });
  const lines = [
    `Harper on port ${listener.port} is ${who}, not this init's data dir ${expectedDataDir}.`,
    `  ${DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD}`,
    `  This init will not send its admin password to that process.`,
    `  This init will not stop a process it did not start.`,
  ];
  appendRemedy(lines, listener);
  return lines.join("\n");
}

/**
 * Appended when init refuses before start because the port is already
 * answering and this data directory has no persisted admin user. Names only
 * what was read. Does not claim the passwords differ.
 */
export function foreignOccupiedListenerDetail(
  listener: OccupiedHarperListener,
  expectedDataDir?: string,
): string {
  const lines = [
    `The process listening on port ${listener.port} is ${describeOccupiedListener(listener)}.`,
    `This init will not send its admin password to a process it did not start.`,
  ];
  if (expectedDataDir && foreignDataDirs(expectedDataDir, listener.dataDirs).length > 0) {
    lines.push(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
  }
  lines.push(`This init will not stop a process it did not start.`);
  appendRemedy(lines, listener);
  return lines.join("\n");
}

/**
 * The operations-API 401 after init skipped its own start. Unlike the
 * pre-auth notice, which is one read, `listener` here is the before-and-after
 * attribution for the operations port: the same sole PID on both sides,
 * or the unattributed fallback. Do not pass the HTTP port's pids through.
 * The rejection is not proof the passwords differ, and it is not proof the
 * HTTP listener caused it. The message does not offer `flair stop`.
 */
export function occupiedListenerAuthFailure(input: {
  /** Existing status lead, including the trailing space before the body. */
  lead: string;
  /** Response body, preserved so the server's own words stay visible. */
  bodyText: string;
  listener: OccupiedHarperListener;
}): string {
  const who = describeOccupiedListener(input.listener);
  const lines = [
    `${input.lead}${input.bodyText}`,
    `  The operations port ${input.listener.port} rejected this init's admin credentials.`,
    `  ${HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT}`,
    `  ${DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD}`,
    `  The process holding the operations port is ${who}.`,
    `  This init will not stop a process it did not start.`,
  ];
  appendRemedy(lines, input.listener);
  return lines.join("\n");
}

/**
 * `kill` only for the one pid this message named. `flair stop` cannot be
 * promised to act on this listener.
 */
function appendRemedy(lines: string[], listener: OccupiedHarperListener): void {
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
