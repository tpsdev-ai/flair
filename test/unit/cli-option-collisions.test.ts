// cli-option-collisions.test.ts — the structural guard for flair#926.
//
// Commander matches an option against a command's OWN option list while it is
// still scanning for the subcommand to dispatch to, so a flag typed after a
// subcommand name is consumed by the first ancestor that recognises it. When a
// subcommand redeclares a name its parent already owns, the parent wins and the
// subcommand's `opts()` has no entry for it at all.
//
// The failure is invisible in three ways at once: no type error, no runtime
// error, and behaviour indistinguishable from the user simply not passing the
// flag. flair#923 hit it with `--admin-pass-file` on `flair federation sync
// enable`, which installed a scheduled driver that failed authentication every
// cycle with nothing surfaced anywhere. Typecheck and unit tests were green;
// only an end-to-end run caught it.
//
// So this file pins two different things, and both are needed:
//
//   1. THE RULE — a synthetic commander tree exercising the exact shape, with a
//      positive control that has no collision. This is what stops the guard
//      below from silently becoming vacuous if commander's binding changes: a
//      test that only asserts "no collisions exist" passes just as happily when
//      the walk is broken as when the tree is clean.
//   2. THE TREE — the real `program`, asserted to contain no collisions at all.
//      Zero tolerance rather than an allowlist: every entry on an allowlist is
//      a trap for whoever adds the next subcommand, and the two mitigations
//      (drop the duplicate declaration, or read `optsWithGlobals()`) are both
//      cheap enough that no exception has to be carved out.
//
// Discoverability is not the cost it looks like. `program.configureHelp({
// showGlobalOptions: true })` lists a parent's options under "Global Options"
// in every subcommand's `--help`, so removing a duplicate declaration hides
// nothing from the operator — the flag is still shown, and still works.
import { describe, test, expect } from "bun:test";
import { Command, Option } from "commander";
import { program } from "../../src/cli";

/** Every (command, option) pair whose name an ancestor already declares. */
interface Collision {
  /** Full command path, e.g. "federation sync enable". */
  path: string;
  /** The `opts()` key — what actually collides. `--admin-pass-file` → `adminPassFile`. */
  attr: string;
  flags: string;
  ancestorPath: string;
  ancestorFlags: string;
}

/**
 * The options a command explicitly declares.
 *
 * This is `cmd.options`, which already includes the one added by `.version()`
 * — the worst case in this class, because commander's version listener exits
 * the process and no `optsWithGlobals()` can recover the value.
 *
 * It deliberately does NOT include commander's lazily-materialised `-h,
 * --help`. Every command has one, so counting it would report a collision on
 * all 125 of them, and it would be wrong: commander resolves help flags at the
 * LEAF after dispatching, not during the ancestor's option scan, so `flair
 * federation sync enable --help` prints `enable`'s help and not its parent's.
 * The synthetic test below pins that rather than trusting the claim, so this
 * exclusion fails loudly if commander ever changes it.
 */
function declaredOptions(cmd: Command): Option[] {
  return [...((cmd as unknown as { options: Option[] }).options)];
}

function findCollisions(root: Command): Collision[] {
  const found: Collision[] = [];

  function walk(cmd: Command, path: string[], ancestors: Array<{ path: string; options: Option[] }>): void {
    const here = [...path, cmd.name()];
    const herePath = here.join(" ");
    const mine = declaredOptions(cmd);

    for (const opt of mine) {
      const attr = opt.attributeName();
      // Nearest ancestor first — that is the one that actually consumes it.
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const clash = ancestors[i].options.find((a) => a.attributeName() === attr);
        if (clash) {
          found.push({
            path: herePath,
            attr,
            flags: opt.flags,
            ancestorPath: ancestors[i].path,
            ancestorFlags: clash.flags,
          });
          break;
        }
      }
    }

    const next = [...ancestors, { path: herePath, options: mine }];
    for (const sub of cmd.commands) walk(sub, here, next);
  }

  const rootName = root.name() || "flair";
  for (const sub of root.commands) {
    walk(sub, [], [{ path: rootName, options: declaredOptions(root) }]);
  }
  return found;
}

function describeCollisions(cs: Collision[]): string {
  return cs
    .map(
      (c) =>
        `  'flair ${c.path}' declares ${c.flags} (opts key: ${c.attr})\n`
        + `      but 'flair ${c.ancestorPath}' already declares ${c.ancestorFlags}, and consumes it.`,
    )
    .join("\n");
}

describe("flair#926 — the rule, on a synthetic tree", () => {
  test("a parent consumes a colliding option and the subcommand sees undefined", () => {
    const root = new Command();
    root.name("flair").exitOverride();
    const parent = root
      .command("parent")
      .option("--shared <v>", "declared on the parent")
      .action(() => {});

    let childOpts: Record<string, unknown> | undefined;
    let childWithGlobals: Record<string, unknown> | undefined;
    let parentOpts: Record<string, unknown> | undefined;
    parent
      .command("child")
      .option("--shared <v>", "redeclared on the child — this is the defect")
      .option("--own <v>", "declared only here")
      .action((opts, cmd) => {
        childOpts = opts;
        childWithGlobals = cmd.optsWithGlobals();
        parentOpts = cmd.parent!.opts();
      });

    root.parse(["node", "flair", "parent", "child", "--shared", "SENTINEL", "--own", "mine"]);

    // The child's own opts() has NO entry — not a wrong value, no entry. That
    // is why the defect reads as "the user did not pass the flag".
    expect(childOpts).toBeDefined();
    expect(childOpts!.shared).toBeUndefined();
    expect("shared" in childOpts!).toBe(false);
    // The value is not lost, it is on the parent.
    expect(parentOpts!.shared).toBe("SENTINEL");
    // ...and optsWithGlobals() is what reaches it. This is the recovery the
    // federation sync subcommands rely on.
    expect(childWithGlobals!.shared).toBe("SENTINEL");
    // A non-colliding option on the same command is unaffected, which is what
    // makes the defect so quiet: everything else on the command works.
    expect(childOpts!.own).toBe("mine");
  });

  test("positive control: with no collision the subcommand receives its own value", () => {
    // Without this, the assertions above could pass because the option never
    // arrived at all — a broken fixture rather than the binding rule.
    const root = new Command();
    root.name("flair").exitOverride();
    const parent = root.command("parent").option("--other <v>", "").action(() => {});
    let childOpts: Record<string, unknown> | undefined;
    parent.command("child").option("--shared <v>", "").action((opts) => { childOpts = opts; });

    root.parse(["node", "flair", "parent", "child", "--shared", "SENTINEL"]);
    expect(childOpts!.shared).toBe("SENTINEL");
  });

  test("--help is NOT in this class: commander resolves it at the leaf", () => {
    // Justifies `declaredOptions` skipping the auto-added help option. Every
    // command has one, so if help behaved like an ordinary option the guard
    // would have to report all 125 commands — and the exclusion that avoids
    // that would be hiding real collisions. It does not: help flags are checked
    // in the leaf subcommand after dispatch, so the deepest command wins.
    const root = new Command();
    root.name("flair").exitOverride();
    let shown = "";
    const parent = root.command("parent").action(() => {});
    const child = parent.command("child").description("the leaf").action(() => {});
    child.configureOutput({ writeOut: (s) => { shown += s; } });
    parent.configureOutput({ writeOut: (s) => { shown += s; } });

    expect(() => root.parse(["node", "flair", "parent", "child", "--help"]))
      .toThrow(expect.objectContaining({ code: "commander.helpDisplayed" }));
    expect(shown).toContain("flair parent child");
    expect(shown).toContain("the leaf");
  });

  test("a collision with the program's --version is not recoverable at all", () => {
    // The reason `flair upgrade` could not keep its `--version <semver>`.
    // Every other collision leaves the value retrievable via optsWithGlobals();
    // this one runs commander's version listener, which writes the version and
    // exits the process before any action is reached. There is nothing to
    // recover and nothing to read — the only fix is a different name.
    const root = new Command();
    root.name("flair").version("9.9.9", "-v, --version").exitOverride();
    root.configureOutput({ writeOut: () => {} });
    let ran = false;
    root.command("upgrade").option("--version <semver>", "").action(() => { ran = true; });

    expect(() => root.parse(["node", "flair", "upgrade", "--version", "1.2.3"]))
      .toThrow(expect.objectContaining({ code: "commander.version" }));
    expect(ran).toBe(false);
  });
});

describe("flair#926 — the real CLI declares no colliding options", () => {
  test("no subcommand redeclares an option name an ancestor already owns", () => {
    const collisions = findCollisions(program as unknown as Command);

    expect(
      collisions.length === 0
        ? ""
        : "Subcommand options shadowed by an ancestor (flair#926):\n"
          + describeCollisions(collisions)
          + "\n\nCommander binds each of these to the ANCESTOR, so the subcommand's"
          + "\nopts() returns undefined for it — silently, with no type or runtime error."
          + "\n\nFix by one of:"
          + "\n  - Drop the duplicate declaration. The parent's already parses the flag,"
          + "\n    it still works on the subcommand, and `showGlobalOptions` keeps it"
          + "\n    listed in the subcommand's --help. Preferred."
          + "\n  - If the subcommand genuinely needs its own, rename it (see"
          + "\n    `flair upgrade --flair-version`)."
          + "\nEither way the action must read cmd.optsWithGlobals(), not its first argument.",
    ).toBe("");
  });

  test("the walk actually traverses the CLI, and would see a collision if one existed", () => {
    // Guards the guard. `findCollisions` returning [] is the pass condition
    // above, and [] is also what a walk that visited nothing returns. So: prove
    // it reaches depth, then prove it still detects a collision when one is
    // planted in the real tree.
    const root = program as unknown as Command;
    let count = 0;
    let maxDepth = 0;
    (function count_(cmd: Command, depth: number): void {
      count++;
      maxDepth = Math.max(maxDepth, depth);
      for (const sub of cmd.commands) count_(sub, depth + 1);
    })(root, 0);
    expect(count).toBeGreaterThan(100);
    expect(maxDepth).toBeGreaterThanOrEqual(3); // e.g. flair federation sync enable

    // Plant one, on a real command, and confirm it is reported.
    const victim = root.commands.find((c) => c.commands.length > 0)!;
    const sub = victim.commands[0];
    const parentOwned = (victim as unknown as { options: Option[] }).options[0]
      ?? (root as unknown as { options: Option[] }).options[0];
    const planted = new Option(parentOwned.flags, "planted by the guard's own test");
    (sub as unknown as { options: Option[] }).options.push(planted);
    try {
      const withPlant = findCollisions(root);
      expect(withPlant.some((c) => c.attr === planted.attributeName())).toBe(true);
    } finally {
      const opts = (sub as unknown as { options: Option[] }).options;
      opts.splice(opts.indexOf(planted), 1);
    }
    // ...and removing it returns the tree to clean.
    expect(findCollisions(root)).toEqual([]);
  });
});

describe("flair#926 — regressions on the two commands this came from", () => {
  test("`flair upgrade` takes --flair-version and never declares --version", () => {
    const upgrade = (program as unknown as Command).commands.find((c) => c.name() === "upgrade")!;
    const names = (upgrade as unknown as { options: Option[] }).options.map((o) => o.attributeName());
    // `--version` on this command was accepted by the shell, printed the CLI's
    // own version, and exited 0 — so `flair upgrade --target X --version 1.2.3`
    // reported success while upgrading nothing.
    expect(names).not.toContain("version");
    expect(names).toContain("flairVersion");
  });

  test("`federation sync` owns the shared flags and its subcommands do not restate them", () => {
    const federation = (program as unknown as Command).commands.find((c) => c.name() === "federation")!;
    const sync = federation.commands.find((c) => c.name() === "sync")!;
    const own = (c: Command) => (c as unknown as { options: Option[] }).options.map((o) => o.attributeName());

    // The parent is where they live, and where commander binds them.
    expect(own(sync)).toEqual(expect.arrayContaining(["port", "adminPassFile", "target"]));

    for (const name of ["enable", "status"]) {
      const child = sync.commands.find((c) => c.name() === name)!;
      expect(own(child)).not.toContain("adminPassFile");
      expect(own(child)).not.toContain("target");
      expect(own(child)).not.toContain("port");
    }
  });

  test("the shared flags are still discoverable on the subcommands", () => {
    // Removing a declaration must not remove the flag from the operator's view
    // — it still works, so it still has to be documented where it is used.
    const federation = (program as unknown as Command).commands.find((c) => c.name() === "federation")!;
    const sync = federation.commands.find((c) => c.name() === "sync")!;
    const status = sync.commands.find((c) => c.name() === "status")!;

    const help = status.helpInformation();
    expect(help).toContain("Global Options:");
    expect(help).toContain("--target");
    expect(help).toContain("--port");
  });
});
