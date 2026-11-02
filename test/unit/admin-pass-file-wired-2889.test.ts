/**
 * admin-pass-file-wired-2889.test.ts — flair#2889
 *
 * The admin-password pair is applied by addAdminPassOptions' preAction hook, so
 * a command cannot accept `--admin-pass-file` while ignoring it. This walks the
 * registered commander tree and requires every command that declares the flag
 * to be in the helper's registry. A command that copies the flag into its own
 * option list fails here by name.
 */

import { describe, expect, test } from "bun:test";
import { adminPassFileWired } from "../../src/lib/auth-resolve";
import { program } from "../../src/cli";
import { walkCliCommands } from "../helpers/cli-surface";

/**
 * `rem nightly enable` records a path for the shim; it does not read the file on
 * this invocation, and a path that does not exist yet is valid
 * (test/integration/rem-nightly-admin-pass-file-809.test.ts enables with one).
 */
const NOT_APPLIED_ON_INVOCATION = new Set(["flair rem nightly enable"]);

describe("flair#2889 — --admin-pass-file is declared only through the wired helper", () => {
  test("every command declaring --admin-pass-file is in the helper's registry", () => {
    const nodes = walkCliCommands(program);
    const declaring = nodes.filter(({ cmd }) => cmd.options.some((o) => o.long === "--admin-pass-file"));

    // The walk must actually have seen the surface it claims to check.
    expect(declaring.length).toBeGreaterThan(40);

    const unwired = declaring.filter(({ cmd }) => !adminPassFileWired.has(cmd)).map(({ path }) => path);
    expect(unwired).toEqual([...NOT_APPLIED_ON_INVOCATION]);
  });

  test("every command declaring --admin-pass is in the helper's registry", () => {
    const nodes = walkCliCommands(program);
    const declaring = nodes.filter(({ cmd }) => cmd.options.some((o) => o.long === "--admin-pass"));

    expect(declaring.length).toBeGreaterThan(40);
    expect(declaring.filter(({ cmd }) => !adminPassFileWired.has(cmd)).map(({ path }) => path)).toEqual([]);
  });
});
