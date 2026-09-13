/**
 * cli-surface.ts — renderer for the flair#1619 CLI-surface snapshot.
 *
 * Walks a commander `Command` tree in registration order and produces a
 * deterministic text dump: every command/subcommand + its declared
 * options/arguments, then each command's real `--help` (outputHelp, including
 * `.addHelpText()`). Help width is pinned so TTY columns cannot change a byte.
 *
 * Host-specific strings (homedir, package version) are replaced so a version
 * bump or a different $HOME does not fail the gate — those are not CLI-surface
 * changes. A dropped/renamed command or changed flag still fails.
 */
import { homedir } from "node:os";
import type { Argument, Command, Option } from "commander";

/** Pinned help wrap. Matches commander's non-TTY default and CI. */
export const CLI_SURFACE_HELP_WIDTH = 80;

export const CLI_SURFACE_UPDATE_ENV = "UPDATE_CLI_SURFACE_SNAPSHOT";

export interface CliSurfaceCounts {
  commands: number;
  options: number;
}

interface CommandNode {
  path: string;
  cmd: Command;
}

function isHiddenCommand(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
}

/**
 * Registration-order walk of `root` and every descendant. The implicit
 * commander `help` command is omitted here (it is not registered in cli.ts);
 * it still appears in the HELP section via outputHelp().
 */
export function walkCliCommands(root: Command): CommandNode[] {
  const out: CommandNode[] = [];
  const visit = (cmd: Command, parts: string[]): void => {
    const path = parts.length > 0 ? parts.join(" ") : cmd.name();
    out.push({ path, cmd });
    const prefix = parts.length > 0 ? parts : [cmd.name()];
    for (const sub of cmd.commands) visit(sub, [...prefix, sub.name()]);
  };
  visit(root, []);
  return out;
}

export function countCliSurface(root: Command): CliSurfaceCounts {
  const nodes = walkCliCommands(root);
  let options = 0;
  for (const { cmd } of nodes) options += cmd.options.length;
  return { commands: nodes.length, options };
}

export function stabilizeCliSurfaceText(
  text: string,
  opts: { home?: string; version?: string; nodeVersion?: string } = {},
): string {
  const home = opts.home ?? homedir();
  const nodeVersion = opts.nodeVersion ?? process.version;
  let out = text;
  if (home) out = out.split(home).join("~");
  if (opts.version) out = out.split(opts.version).join("$FLAIR_VERSION");
  // The committed dump is generated under bun; CI's Node 22/24/26 matrix
  // only affects the pre-lane node scripts. Still strip the runtime version
  // so a future help string that mentions process.version cannot false-fail
  // one matrix leg (flair#1619 / PR #1637).
  if (nodeVersion) out = out.split(nodeVersion).join("$NODE_VERSION");
  return out;
}

function formatDefault(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatOption(opt: Option): string[] {
  const lines = [`    ${opt.flags}`];
  if (opt.description) lines.push(`      description: ${opt.description}`);
  lines.push(`      attr: ${opt.attributeName()}`);
  if (opt.mandatory) lines.push("      mandatory: true");
  if (opt.hidden) lines.push("      hidden: true");
  if (opt.defaultValue !== undefined) {
    lines.push(`      default: ${formatDefault(opt.defaultValue)}`);
  }
  if (opt.defaultValueDescription) {
    lines.push(`      defaultDescription: ${opt.defaultValueDescription}`);
  }
  if (opt.envVar) lines.push(`      env: ${opt.envVar}`);
  if (opt.argChoices?.length) {
    lines.push(`      choices: ${opt.argChoices.map((c) => JSON.stringify(c)).join(", ")}`);
  }
  if (opt.negate) lines.push("      negate: true");
  if (opt.variadic) lines.push("      variadic: true");
  return lines;
}

function formatArgument(arg: Argument): string[] {
  const bits = [arg.required ? "required" : "optional"];
  if (arg.variadic) bits.push("variadic");
  const lines = [`    ${arg.name()} (${bits.join(", ")})`];
  if (arg.description) lines.push(`      description: ${arg.description}`);
  if (arg.defaultValue !== undefined) {
    lines.push(`      default: ${formatDefault(arg.defaultValue)}`);
  }
  if (arg.argChoices?.length) {
    lines.push(`      choices: ${arg.argChoices.map((c) => JSON.stringify(c)).join(", ")}`);
  }
  return lines;
}

function formatCommandTree(path: string, cmd: Command): string {
  const lines = [path];
  const description = cmd.description();
  if (description) lines.push(`  description: ${description}`);
  const summary = cmd.summary();
  if (summary && summary !== description) lines.push(`  summary: ${summary}`);
  lines.push(`  usage: ${cmd.usage()}`);
  const aliases = cmd.aliases();
  if (aliases.length > 0) lines.push(`  aliases: ${aliases.join(", ")}`);
  if (isHiddenCommand(cmd)) lines.push("  hidden: true");

  const args = cmd.registeredArguments;
  if (args.length > 0) {
    lines.push("  arguments:");
    for (const arg of args) lines.push(...formatArgument(arg));
  }

  if (cmd.options.length === 0) {
    lines.push("  options: (none)");
  } else {
    lines.push("  options:");
    for (const opt of cmd.options) lines.push(...formatOption(opt));
  }

  if (cmd.commands.length > 0) {
    lines.push(`  subcommands: ${cmd.commands.map((c) => c.name()).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Capture the operator-visible `--help` for `cmd`, including `.addHelpText()`.
 *
 * `helpInformation()` omits addHelpText (those ride on outputHelp events).
 * Output is forced to a fixed width and no color so CI and a local TTY match.
 *
 * Mutates `cmd`'s output configuration. Callers that share `program` with
 * other tests must run this in an isolated process.
 */
export function captureCommandHelp(
  cmd: Command,
  helpWidth = CLI_SURFACE_HELP_WIDTH,
): string {
  let captured = "";
  cmd.configureOutput({
    writeOut: (s: string) => {
      captured += s;
    },
    writeErr: (s: string) => {
      captured += s;
    },
    getOutHelpWidth: () => helpWidth,
    getErrHelpWidth: () => helpWidth,
    getOutHasColors: () => false,
    getErrHasColors: () => false,
  });
  cmd.outputHelp();
  return captured;
}

export function renderCliSurfaceSnapshot(root: Command): string {
  const nodes = walkCliCommands(root);
  const counts = countCliSurface(root);
  const version = root.version();

  const tree = nodes.map(({ path, cmd }) => formatCommandTree(path, cmd)).join("\n\n");
  const help = nodes
    .map(({ path, cmd }) => `----- ${path} -----\n${captureCommandHelp(cmd)}`)
    .join("\n");

  const body = [
    "# Flair CLI surface snapshot (flair#1619)",
    "# Byte-identical gate for src/cli.ts modularization. Do not edit by hand.",
    `# Refresh: ${CLI_SURFACE_UPDATE_ENV}=1 bun test test/unit-isolated/cli-surface-snapshot.test.ts`,
    `# helpWidth=${CLI_SURFACE_HELP_WIDTH} (pinned; TTY columns must not affect this file)`,
    `# commands=${counts.commands} options=${counts.options}`,
    "#",
    "# TREE is registration order: every command/subcommand + declared options/args.",
    "# HELP is each command's outputHelp() (--help, including addHelpText).",
    "# Homedir, CLI version, and process.version are replaced so env/runtime is not a miss.",
    "",
    "========================================================================",
    "TREE",
    "========================================================================",
    "",
    tree,
    "",
    "========================================================================",
    "HELP",
    "========================================================================",
    "",
    help,
  ].join("\n");

  const stabilized = stabilizeCliSurfaceText(body, { version });
  return stabilized.endsWith("\n") ? stabilized : `${stabilized}\n`;
}
