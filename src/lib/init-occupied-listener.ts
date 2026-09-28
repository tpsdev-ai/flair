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
 * A pid is named, and `kill` is printed, only for a process verified to hold
 * the port that answered. Otherwise the listener is "a Harper instance this
 * init did not start". `flair stop` is offered only when that data directory
 * still records the process (pidfile and sidecar). A deleted data directory
 * does not. Init never signals a process it did not start.
 */
import { canonicalLexicalPath } from "./daemon-liveness.js";

/** What init could read about the process holding one specific port. */
export interface OccupiedHarperListener {
  /** The port this attribution was read from — the port that answered. */
  port: number;
  /**
   * PIDs verified to be listening on `port`. Empty when they could not be
   * verified: the message then uses the unattributed fallback and does not
   * suggest `kill`.
   */
  pids: number[];
  /** ROOTPATH values read from those pids. Empty when environ could not be read. */
  dataDirs: string[];
  /**
   * True only when `flair stop` can identify this process: a data directory
   * that still has both `hdb.pid` and `flair-daemon.json` naming one of
   * `pids`. False after that directory was deleted.
   */
  flairStopApplies: boolean;
}

/**
 * Keep only candidates that were verified to hold the port that answered.
 * `null` means the check could not be made — name nobody. A pid seen only
 * on a different port (HTTP vs operations) is not a kill target.
 */
export function pidsVerifiedOnAnsweredPort(
  candidates: readonly number[],
  verifiedHolders: readonly number[] | null,
): number[] {
  if (verifiedHolders === null) return [];
  const holders = new Set(verifiedHolders);
  return candidates.filter((pid) => holders.has(pid));
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
 * Name the listener for an operator. Pid and data directory when both were
 * read; whichever was read, plus the fallback phrase, when only one was;
 * the fallback phrase alone when neither was.
 */
export function describeOccupiedListener(listener: Pick<OccupiedHarperListener, "pids" | "dataDirs">): string {
  const pid = listener.pids.length > 0 ? `pid ${listener.pids.join(", ")}` : null;
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
 * Printed when the HTTP listener's ROOTPATH is a different directory, and
 * init exits on it — before the authenticated health request and before the
 * operations insert. A different directory is not proof the passwords differ.
 * Returns null when the directory matches or could not be read (that is not
 * proof of a foreign instance either).
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

/** `kill` when a pid was verified on this port. `flair stop` only when it can identify that process. */
function appendRemedy(lines: string[], listener: OccupiedHarperListener): void {
  if (listener.pids.length > 0) lines.push(`  kill ${listener.pids.join(" ")}`);
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
