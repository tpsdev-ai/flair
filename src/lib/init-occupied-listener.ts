/**
 * init-occupied-listener.ts — flair#1749
 *
 * `flair init` treats "something already answered /health" as "our Harper is
 * up" and skips its own start. A later operations-API 401 is then explained
 * as a wrong `--admin-pass` / `--admin-user`. That 401 is the other process:
 * its admin credentials differ from the ones this init has.
 *
 * Attribution is best-effort. Pid and data directory are named when they
 * can be read; otherwise the listener is "a Harper instance this init did
 * not start". The remedy prints `kill` and `flair stop`. It never signals
 * the process — init must not stop a Harper it did not start.
 */
import { canonicalLexicalPath } from "./daemon-liveness.js";

/** What init could read about the process that already held the HTTP port. */
export interface OccupiedHarperListener {
  /** HTTP port init found already answering. */
  port: number;
  /** PIDs listening on that port. Empty when lsof could not name them. */
  pids: number[];
  /** ROOTPATH values read from those pids. Empty when environ could not be read. */
  dataDirs: string[];
}

/**
 * Name the listener for an operator. Pid and data directory when both were
 * read; whichever was read, plus the fallback phrase, when only one was;
 * the fallback phrase alone when neither was.
 */
export function describeOccupiedListener(listener: Pick<OccupiedHarperListener, "pids" | "dataDirs">): string {
  const pid = listener.pids.length > 0 ? `pid ${listener.pids.join(", ")}` : null;
  const dir = listener.dataDirs.length > 0 ? `data dir ${listener.dataDirs.join(", ")}` : null;
  if (pid && dir) return `${pid}, ${dir}`;
  if (pid || dir) return `${pid ?? dir} (a Harper instance this init did not start)`;
  return "a Harper instance this init did not start";
}

/**
 * Printed before init sends this run's admin password, and only when a
 * readable ROOTPATH is a different directory from the one init is setting
 * up. A matching path is not proof the password will be accepted — the
 * 401 message covers that — and an unreadable environ is not proof it
 * will not.
 */
export function staleHarperBeforeAuthNotice(
  expectedDataDir: string,
  listener: OccupiedHarperListener,
): string | null {
  if (listener.dataDirs.length === 0) return null;
  const expected = canonicalLexicalPath(expectedDataDir);
  const foreign = listener.dataDirs.filter((dir) => canonicalLexicalPath(dir) !== expected);
  if (foreign.length === 0) return null;
  const who = describeOccupiedListener({ pids: listener.pids, dataDirs: foreign });
  const lines = [
    `Harper on port ${listener.port} is ${who}, not this init's data dir ${expectedDataDir}.`,
    `  That process's admin password will not match the one this init has.`,
    `  This init will not stop a process it did not start.`,
  ];
  if (listener.pids.length > 0) lines.push(`  kill ${listener.pids.join(" ")}`);
  else lines.push(`  flair stop`);
  return lines.join("\n");
}

/**
 * Identity plus the stop commands. Shared by the 401 (init already skipped
 * start) and the earlier foreign-instance refusal (init will not generate a
 * password against a port it did not bind). Never includes a signal — the
 * caller prints this, it does not run it.
 */
function occupiedListenerStopLines(listener: OccupiedHarperListener, cause: string): string[] {
  const lines = [
    `The process listening on port ${listener.port} is ${describeOccupiedListener(listener)}.`,
    cause,
    `Stop it, or point init at its data directory. This init will not stop a process it did not start.`,
  ];
  if (listener.pids.length > 0) lines.push(`kill ${listener.pids.join(" ")}`);
  lines.push(`flair stop`);
  for (const dir of listener.dataDirs) {
    lines.push(`flair init --data-dir ${commandArg(dir)}`);
  }
  return lines;
}

/**
 * Appended when init refuses before start: the port is already answering and
 * this data directory has no persisted admin user. `flair stop` alone cannot
 * see that process after `~/.flair` was removed — there is no pidfile — so
 * the kill line names it.
 */
export function foreignOccupiedListenerDetail(listener: OccupiedHarperListener): string {
  return occupiedListenerStopLines(
    listener,
    `That process's admin password will not match the one this init has.`,
  ).join("\n");
}

/**
 * The operations-API 401 after init skipped its own start. Replaces the
 * credential hint: the rejection belongs to the process already on the
 * port, not to a wrong `--admin-pass` on this init.
 */
export function occupiedListenerAuthFailure(input: {
  /** Existing status lead, including the trailing space before the body. */
  lead: string;
  /** Response body, preserved so the server's own words stay visible. */
  bodyText: string;
  listener: OccupiedHarperListener;
}): string {
  const detail = occupiedListenerStopLines(
    input.listener,
    `That instance's admin credentials differ from the ones this init has.`,
  ).map((line) => `  ${line}`);
  return [`${input.lead}${input.bodyText}`, ...detail].join("\n");
}

/** Quote a path that would split on the shell. Numbers and plain paths stay bare. */
function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
