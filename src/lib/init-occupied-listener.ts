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
 * Init can name a different data directory only when it could read one.
 * An unreadable ROOTPATH is not proof of a foreign instance.
 *
 * A pid is named, and `kill` is printed, only when the failure can be tied
 * to one stable holder of the port that answered (the same single pid before
 * the request and after it). Several holders, or a holder that changed
 * during the request, stay "a Harper instance this init did not start".
 * `flair stop` has no `--data-dir` and always acts on the default data
 * directory, so it is offered only when that directory still records this
 * listener — once, not also from the refusal head. Any other directory gets
 * the process remedy. Init never signals a process it did not start.
 */
import { canonicalLexicalPath } from "./daemon-liveness.js";

/** What init could read about the process holding one specific port. */
export interface OccupiedHarperListener {
  /** The port this attribution was read from — the port that answered. */
  port: number;
  /**
   * PIDs listening on `port` at this read. A message names a pid only when
   * this list has exactly one entry, and an operations-port 401 names it
   * only when the read before the insert and the read after the 401 agree
   * on that same pid. Empty, or more than one, is the unattributed fallback:
   * do not suggest `kill` for every pid in the list.
   */
  pids: number[];
  /**
   * ROOTPATH values actually read from those pids. Empty when the lookup
   * could not read a directory — that is not a foreign data directory.
   */
  dataDirs: string[];
  /**
   * True only when bare `flair stop` will act on this listener. That command
   * has no `--data-dir` and always reads the default data directory, so this
   * is true only when THAT directory's pidfile and sidecar name a pid
   * holding this port. A record in the listener's own directory does not
   * qualify when that directory is not the default. False after the default
   * directory was deleted.
   */
  flairStopApplies: boolean;
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
 * One pid, the same pid on both sides of the request: that holder. Zero
 * pids, several pids, or a different pid after the request: nobody. The
 * fallback does not keep data directories or `flair stop` from a set of
 * processes the 401 was not tied to.
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
    return { port: after.port, pids: [], dataDirs: [], flairStopApplies: false };
  }
  return {
    port: after.port,
    pids: [after.pids[0]],
    dataDirs: after.dataDirs,
    flairStopApplies: after.flairStopApplies,
  };
}

/**
 * `flair stop` identifies a daemon from the data directory's pidfile and
 * sidecar. Both must name a pid that holds the port. A missing directory
 * (the deleted-`~/.flair` orphan) does not qualify.
 */
export function flairStopCanIdentify(input: {
  recordedPid: number | null;
  sidecarPid: number | null;
  listenerPids: readonly number[];
}): boolean {
  if (input.recordedPid === null || input.sidecarPid === null) return false;
  if (input.recordedPid !== input.sidecarPid) return false;
  return input.listenerPids.includes(input.recordedPid);
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
 * Printed when init could read a ROOTPATH for the HTTP listener and it is a
 * different directory. Init exits on it — before the authenticated health
 * request and before the operations insert. A different directory is not
 * proof the passwords differ. Returns null when the directory matches or
 * could not be read: an unreadable lookup is not a foreign instance, and
 * init must not claim it exited because the process had another directory.
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
 * The operations-API 401 after init skipped its own start and did not
 * already know the HTTP listener was a different data directory.
 *
 * `listener` must be the process verified to hold the operations port (the
 * port that answered). An empty pid list is the unattributed fallback — do
 * not pass the HTTP port's pids through. The rejection is not, by itself,
 * proof that those passwords differ from a different directory, and it is
 * not proof the HTTP listener caused it.
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
 * `kill` only for the one pid the failure was tied to. `flair stop` only
 * when that command will act on this listener (the default data directory
 * records it). The two are not both required: a non-default directory gets
 * the process remedy and does not get `flair stop`.
 */
function appendRemedy(lines: string[], listener: OccupiedHarperListener): void {
  if (listener.pids.length === 1) lines.push(`  kill ${listener.pids[0]}`);
  if (listener.flairStopApplies) lines.push(`  flair stop`);
  for (const dir of listener.dataDirs) {
    lines.push(`  flair init --data-dir ${commandArg(dir)}`);
  }
}

/** Quote a path that would split on the shell. Numbers and plain paths stay bare. */
function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
