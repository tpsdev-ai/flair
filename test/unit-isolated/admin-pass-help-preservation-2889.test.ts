import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { program } from "../../src/cli";
import { walkCliCommands } from "../helpers/cli-surface";

interface CommandFixture {
  adminPass?: string;
  options: string[];
}

const FIXTURE: Record<string, CommandFixture> = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "admin-pass-help-origin-main.json"), "utf8"),
);

function optionNames(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? o.short ?? o.flags);
}

describe("flair#2889 — --admin-pass descriptions", () => {
  test("--admin-pass descriptions match the fixture except mcp disable", () => {
    const current = new Map<string, string>();
    for (const { path, cmd } of walkCliCommands(program)) {
      const option = cmd.options.find((o) => o.long === "--admin-pass");
      if (option) current.set(path, option.description);
    }

    // The walk must have seen the surface it claims to check.
    expect(current.size).toBeGreaterThan(20);

    const expected = Object.entries(FIXTURE)
      .filter(([, entry]) => entry.adminPass !== undefined)
      .map(([path, entry]) => [path, path === "flair mcp disable"
        ? "Admin password for the target instance; use --admin-pass or --admin-pass-file"
        : entry.adminPass] as const);
    expect(expected.length).toBe(current.size);
    expect(expected.filter(([path, description]) => current.get(path) !== description)).toEqual([]);
    expect([...current.keys()].filter((path) => FIXTURE[path]?.adminPass === undefined)).toEqual([]);
  });
});

describe("flair#2889 — --admin-pass-file does not reorder options", () => {
  test("option order matches the fixture after removing --admin-pass-file", () => {
    const walked = new Map<string, string[]>();
    for (const { path, cmd } of walkCliCommands(program)) walked.set(path, optionNames(cmd));

    // The walk must have seen the surface it claims to check.
    expect(walked.size).toBeGreaterThan(100);
    expect(Object.keys(FIXTURE).length).toBe(walked.size);

    const drifted = [...walked]
      .map(([path, options]) => {
        const expected = (FIXTURE[path]?.options ?? []).filter((name) => name !== "--admin-pass-file");
        const actual = options.filter((name) => name !== "--admin-pass-file");
        return { path, expected, actual };
      })
      .filter(({ expected, actual }) => expected.join(" ") !== actual.join(" "));

    expect(drifted).toEqual([]);
    expect(Object.keys(FIXTURE).filter((path) => !walked.has(path))).toEqual([]);
  });
});

for (const path of ["agent list", "mcp enable"]) {
  test(`${path} file help describes the file and option conflict`, () => {
    const cmd = walkCliCommands(program).find((entry) => entry.path === `flair ${path}`)?.cmd;
    expect(cmd).toBeDefined();
    const help = cmd!.options.find((option) => option.long === "--admin-pass-file")!.description;
    expect(help).toBe(
      "Read the admin password from an owner-only file (group and world permission bits are refused; an owner-only mode such as 0600 or 0400 is accepted), keeping it out of shell history and the process list. " +
      "Combining it with --admin-pass is a usage error.",
    );
    expect(cmd!.helpInformation().replace(/\s+/g, " ")).toContain(help);
  });
}
