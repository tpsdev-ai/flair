import { describe, test, expect } from "bun:test";
import { probeBinVersion, probeLibVersion } from "../../src/cli";

// execFileSync takes (file, args, opts) and returns Buffer|string. Tests
// inject a fake that ignores input and returns a fixed string (or throws).
type ExecFile = typeof import("node:child_process").execFileSync;
const fake = (fn: (file: string, args?: readonly string[]) => string): ExecFile =>
  ((file: string, args?: readonly string[]) => fn(file, args)) as unknown as ExecFile;

describe("probeBinVersion", () => {
  test("returns the parsed semver when the binary prints a version string", () => {
    const e = fake(() => "0.6.0\n");
    expect(probeBinVersion(e, "flair")).toBe("0.6.0");
  });

  test("handles a version embedded in a longer line (e.g., 'flair 0.6.0 (abc)')", () => {
    const e = fake(() => "flair 0.6.0 (rev abc)\n");
    expect(probeBinVersion(e, "flair")).toBe("0.6.0");
  });

  test("handles pre-release / rc versions", () => {
    const e = fake(() => "1.0.0-rc.1\n");
    expect(probeBinVersion(e, "flair")).toBe("1.0.0-rc.1");
  });

  test("returns null when the binary isn't installed (execFileSync throws)", () => {
    const e = fake(() => { throw new Error("ENOENT: command not found"); });
    expect(probeBinVersion(e, "flair")).toBeNull();
  });

  test("returns null when the binary produces no version string", () => {
    const e = fake(() => "no version info here\n");
    expect(probeBinVersion(e, "flair")).toBeNull();
  });

  test("returns null on empty stdout", () => {
    const e = fake(() => "");
    expect(probeBinVersion(e, "flair")).toBeNull();
  });

  test("passes the binary name as argv[0] and --version as argv[1] (no shell)", () => {
    let sawFile = ""; let sawArgs: readonly string[] | undefined = undefined;
    const e = fake((file, args) => { sawFile = file; sawArgs = args; return "0.6.0"; });
    probeBinVersion(e, "flair-mcp");
    expect(sawFile).toBe("flair-mcp");
    expect(sawArgs).toEqual(["--version"]);
  });
});

describe("probeLibVersion", () => {
  test("resolves a package that's in the running module graph", () => {
    const version = probeLibVersion("js-yaml");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("returns null for a package that's not installed anywhere Node can find it", () => {
    const version = probeLibVersion("this-package-does-not-exist-anywhere-3f8c2a1b");
    expect(version).toBeNull();
  });
});
