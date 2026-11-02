/**
 * help-path-2887.test.ts — flair#2887.
 *
 * `flair help <command> <subcommand>` used to print the parent's help, because
 * commander's implicit help command forwards only its first operand. These
 * tests drive the REAL registered program: every leaf reachable by walking the
 * commander tree is compared against the same leaf's `--help`, and every action
 * except `help`'s own is wrapped so that running one during help fails the file.
 *
 * Isolated: installs exit overrides on the shared `program` and writes through
 * process.stdout/stderr spies.
 */
import { describe, expect, test } from "bun:test";
import { CommanderError, type Command } from "commander";
import { program } from "../../src/cli.ts";

interface CommandNode {
  path: string;
  cmd: Command;
}

/** Registration-order walk of the real program and every command below it. */
function commandNodes(root: Command): CommandNode[] {
  const out: CommandNode[] = [];
  const visit = (cmd: Command, parts: string[]): void => {
    out.push({ path: parts.join(" "), cmd });
    for (const sub of cmd.commands) visit(sub, [...parts, sub.name()]);
  };
  for (const sub of root.commands) visit(sub, [sub.name()]);
  return out;
}

/** Every registered leaf path (a command with no subcommands). */
function leafPaths(): string[] {
  return commandNodes(program)
    .filter(({ cmd }) => cmd.commands.length === 0)
    .map(({ path }) => path);
}

// A leaf's `--help` exits through commander's `_exit`; without an override it
// would end this test process.
for (const { cmd } of commandNodes(program)) cmd.exitOverride();

interface RunResult {
  out: string;
  err: string;
  code: number;
}

/** Parse real argv against the real program and keep every byte it printed. */
async function run(argv: string[]): Promise<RunResult> {
  let out = "";
  let err = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = 0;
  let code = 0;
  try {
    try {
      await program.parseAsync(argv, { from: "user" });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      code = error.exitCode;
    }
    const settled = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = 0;
    return { out, err, code: code || settled };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("flair#2887 — help resolves the full command path", () => {
  test("every registered leaf path prints the same help as <path> --help", async () => {
    const paths = leafPaths();
    expect(paths.length).toBeGreaterThan(100);
    const mismatches: string[] = [];
    for (const path of paths) {
      const viaHelp = await run(["help", ...path.split(" ")]);
      const viaFlag = await run([...path.split(" "), "--help"]);
      if (
        viaHelp.out !== viaFlag.out
        || viaHelp.err !== viaFlag.err
        || viaHelp.code !== 0
        || viaFlag.code !== 0
      ) {
        mismatches.push(path);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  test("help presence set shows the leaf's own options", async () => {
    const result = await run(["help", "presence", "set"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--activity");
  });

  test("help workspace set shows the leaf's own options", async () => {
    const result = await run(["help", "workspace", "set"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--ref");
  });

  test("an unknown path prints the deepest match, an unknown-command line, and fails", async () => {
    const result = await run(["help", "presence", "nosuch"]);
    const parent = await run(["presence", "--help"]);
    expect(result.out).toBe(parent.out);
    expect(result.err.trim()).toBe("error: unknown command 'nosuch'");
    expect(result.code).not.toBe(0);
  });

  test("resolving help invokes no command action", async () => {
    const invoked: string[] = [];
    const restores: Array<() => void> = [];
    for (const { path, cmd } of commandNodes(program)) {
      // `help`'s own action is the code under test, not a command being helped.
      if (path === "help") continue;
      const internal = cmd as unknown as { _actionHandler?: (...args: unknown[]) => unknown };
      const original = internal._actionHandler;
      if (typeof original !== "function") continue;
      internal._actionHandler = (...args: unknown[]): never => {
        invoked.push(path);
        throw new Error(`command action ran during help: ${path}`);
      };
      restores.push(() => {
        internal._actionHandler = original;
      });
    }
    try {
      for (const path of leafPaths()) await run(["help", ...path.split(" ")]);
      await run(["help", "presence", "nosuch"]);
    } finally {
      for (const restore of restores) restore();
    }
    expect(invoked).toEqual([]);
  }, 120_000);
});
