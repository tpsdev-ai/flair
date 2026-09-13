/**
 * cli-surface-snapshot.test.ts — flair#1619 (LANDS FIRST for epic #1618).
 *
 * Enumerates the real commander `program` — every command/subcommand + its
 * options/flags, and each command's `--help` — and asserts byte-identity
 * against the committed snapshot. A dropped/renamed command or changed flag
 * fails the unit lane. Nothing in the modularization epic extracts until
 * this guard is green.
 *
 * Isolated: the walk imports src/cli.ts (registration only; import.meta.main
 * is false, so no daemon) and outputHelp() configures each command's writer.
 * A sibling unit test briefly mutates program.options; a dedicated process
 * keeps this snapshot from observing that.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Option } from "commander";
import { program } from "../../src/cli.ts";
import {
  CLI_SURFACE_UPDATE_ENV,
  countCliSurface,
  renderCliSurfaceSnapshot,
} from "../helpers/cli-surface.ts";

const SNAPSHOT_PATH = join(import.meta.dir, "cli-surface.snapshot.txt");

function committedSnapshot(): string {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `CLI surface snapshot missing at ${SNAPSHOT_PATH}. Generate it with `
      + `${CLI_SURFACE_UPDATE_ENV}=1 bun test ${import.meta.path}`,
    );
  }
  return readFileSync(SNAPSHOT_PATH, "utf8");
}

describe("flair#1619 — CLI surface snapshot", () => {
  test("the registered program matches the committed surface snapshot", () => {
    const actual = renderCliSurfaceSnapshot(program);
    if (process.env[CLI_SURFACE_UPDATE_ENV] === "1") {
      writeFileSync(SNAPSHOT_PATH, actual, "utf8");
    }
    expect(actual).toBe(committedSnapshot());
  });

  test("the walk actually traverses the CLI (guard the guard)", () => {
    const { commands, options } = countCliSurface(program);
    expect(commands).toBeGreaterThan(100);
    expect(options).toBeGreaterThan(100);

    const actual = renderCliSurfaceSnapshot(program);
    expect(actual).toContain("\nflair init\n");
    expect(actual).toContain("\nflair federation sync enable\n");
    expect(actual).toContain("\nflair memory add\n");
    expect(actual).toContain("----- flair -----");
    expect(actual).toContain("----- flair memory add -----");
    expect(actual).toContain("Usage:");
    // Runtime identity must not leak into the committed dump. CI runs this
    // under bun on every Node matrix leg; a leaked process.version would
    // false-fail one major.
    expect(actual).not.toContain(process.version);
    expect(actual).not.toMatch(/\bv(?:22|24|26)\.\d+\.\d+\b/);
  });

  test("a dropped or renamed flag fails the snapshot", () => {
    const victim = program.commands.find((c) => c.name() === "init");
    expect(victim).toBeDefined();
    const planted = new Option("--cli-surface-canary <v>", "planted by the guard");
    const opts = (victim as unknown as { options: Option[] }).options;
    opts.push(planted);
    try {
      const actual = renderCliSurfaceSnapshot(program);
      expect(actual).toContain("--cli-surface-canary");
      expect(actual).not.toBe(committedSnapshot());
    } finally {
      const i = opts.indexOf(planted);
      if (i >= 0) opts.splice(i, 1);
    }
  });
});
