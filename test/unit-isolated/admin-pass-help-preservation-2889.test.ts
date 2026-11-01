/**
 * admin-pass-help-preservation-2889.test.ts — flair#2889 fix round.
 *
 * Adding `--admin-pass-file` must not change the `--admin-pass` description a
 * command already had. The fixture is the raw `--admin-pass` description for
 * every command that declared one on origin/main (8b5096d9), generated from
 * main's CLI by walking the registered commander tree with the same
 * `walkCliCommands` helper the CLI-surface snapshot uses.
 *
 * Isolated: it imports src/cli.ts (registration only) in its own process.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { program } from "../../src/cli";
import { walkCliCommands } from "../helpers/cli-surface";

const FIXTURE: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "admin-pass-help-origin-main.json"), "utf8"),
);

describe("flair#2889 — --admin-pass descriptions are preserved", () => {
  test("every command's --admin-pass description matches origin/main", () => {
    const current = new Map<string, string>();
    for (const { path, cmd } of walkCliCommands(program)) {
      const option = cmd.options.find((o) => o.long === "--admin-pass");
      if (option) current.set(path, option.description);
    }

    // The walk must have seen the surface it claims to check.
    expect(current.size).toBeGreaterThan(20);

    const drifted = [...current].filter(([path, description]) => FIXTURE[path] !== description);
    expect(drifted).toEqual([]);
    expect(Object.keys(FIXTURE).filter((path) => !current.has(path))).toEqual([]);
  });
});
