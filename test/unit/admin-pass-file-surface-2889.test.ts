/**
 * admin-pass-file-surface-2889.test.ts — flair#2889
 *
 * `--admin-pass-file` is the documented way to pass the admin password, but
 * most commands that declare `--admin-pass` did not accept it, so the
 * documented path failed with `error: unknown option '--admin-pass-file'`.
 *
 * This walks the REGISTERED commander tree (the program object after every
 * command group has registered), not the source text: a command that declares
 * `--admin-pass` must also declare `--admin-pass-file`. A new command that
 * copies only the argv form fails here by name.
 */

import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { program } from "../../src/cli";

interface Declared {
  /** Space-joined command path, e.g. "agent list". */
  path: string;
  long: readonly (string | undefined)[];
}

/** Every registered command, depth first, including the root program. */
function declaredCommands(root: Command): Declared[] {
  const out: Declared[] = [];
  const walk = (cmd: Command, path: string[]): void => {
    out.push({ path: path.length === 0 ? cmd.name() : path.join(" "), long: cmd.options.map((o) => o.long) });
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()]);
  };
  walk(root, []);
  return out;
}

describe("flair#2889 — every --admin-pass command accepts --admin-pass-file", () => {
  test("the registered command tree declares --admin-pass-file wherever it declares --admin-pass", () => {
    const commands = declaredCommands(program);
    const missing = commands
      .filter((cmd) => cmd.long.includes("--admin-pass") && !cmd.long.includes("--admin-pass-file"))
      .map((cmd) => cmd.path);

    // The walk must actually have seen the surface it claims to check.
    const withPass = commands.filter((cmd) => cmd.long.includes("--admin-pass"));
    expect(withPass.length).toBeGreaterThan(20);

    expect(missing).toEqual([]);
  });
});
