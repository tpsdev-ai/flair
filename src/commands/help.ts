/**
 * help.ts — `flair help <command> ...`.
 *
 * flair#2887: commander's implicit `help` command forwards only its first
 * operand, so `flair help presence set` printed `flair presence`'s help. This
 * registered command resolves the whole path and prints that command's help,
 * the same bytes as `<path> --help`. Resolving help never invokes a command
 * action.
 */
import type { Command } from "commander";

/** Register `flair help`. Called last, so the root listing keeps the help entry at the bottom. */
export function registerHelp(program: Command): void {
  program
    .command("help")
    .argument("[command...]")
    .description("display help for command")
    .action((path: string[]) => {
      let target: Command = program;
      let unknown: string | undefined;
      for (const name of path) {
        const next = target.commands.find(
          (candidate) => candidate.name() === name || candidate.aliases().includes(name),
        );
        if (!next) {
          unknown = name;
          break;
        }
        target = next;
      }
      target.outputHelp();
      if (unknown !== undefined) {
        // Same wording as commander's own unknown-command error, on stderr.
        process.stderr.write(`error: unknown command '${unknown}'\n`);
        process.exitCode = 1;
      }
    });
}
