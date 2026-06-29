import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeBinVersion, probeLibVersion, probeOpenclawPluginVersion, shouldPrintUpgradeLine } from "../../src/cli";

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

describe("probeOpenclawPluginVersion", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "tps-openclaw-probe-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("reads version from ~/.openclaw/extensions/<name>/package.json", () => {
    const extDir = join(tmpHome, ".openclaw", "extensions", "openclaw-flair");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/openclaw-flair", version: "0.7.0" }));
    expect(probeOpenclawPluginVersion("openclaw-flair")).toBe("0.7.0");
  });

  test("returns null when ~/.openclaw doesn't exist (openclaw not installed)", () => {
    expect(probeOpenclawPluginVersion("openclaw-flair")).toBeNull();
  });

  test("returns null when extension dir exists but no package.json", () => {
    const extDir = join(tmpHome, ".openclaw", "extensions", "openclaw-flair");
    mkdirSync(extDir, { recursive: true });
    expect(probeOpenclawPluginVersion("openclaw-flair")).toBeNull();
  });

  test("returns null when package.json is malformed", () => {
    const extDir = join(tmpHome, ".openclaw", "extensions", "openclaw-flair");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "package.json"), "{ this is not valid json");
    expect(probeOpenclawPluginVersion("openclaw-flair")).toBeNull();
  });

  test("returns null when package.json has no version field", () => {
    const extDir = join(tmpHome, ".openclaw", "extensions", "openclaw-flair");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/openclaw-flair" }));
    expect(probeOpenclawPluginVersion("openclaw-flair")).toBeNull();
  });
});

// The flair-mcp package entry in `flair upgrade` probes via
//   probeBinVersion(execFileSync, "flair-mcp") ?? probeLibVersion("@tpsdev-ai/flair-mcp")
// so an older install that's globally present but not on PATH / has no
// `--version` (e.g. 0.10.0, ops-p42n) is still detected via the lib probe
// instead of falsely reporting "not detected". These tests pin that
// bin→lib fallback composition and the resulting detected/outdated status.
describe("flair-mcp bin→lib probe fallback (ops-p42n)", () => {
  // Mirror the upgrade command's status mapping for the assertions below.
  const statusFor = (installed: string | null, latest: string) =>
    installed === null ? "missing" : installed === latest ? "current" : "outdated";

  test("falls back to the lib probe when the bin probe returns null (still detected)", () => {
    // bin probe returns null (binary not on PATH / no --version support)…
    const binNull = fake(() => { throw new Error("ENOENT: flair-mcp not found"); });
    // …but the package IS resolvable in the module graph (js-yaml stands in
    // for a sibling global install of flair-mcp — both are version-independent).
    const detected = probeBinVersion(binNull, "flair-mcp") ?? probeLibVersion("js-yaml");
    expect(detected).not.toBeNull();
    expect(detected).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("a globally-installed-but-binless flair-mcp is treated as outdated when < latest", () => {
    // Real-world ops-p42n: 0.10.0 installed, bin probe null, lib probe finds it.
    const binNull = fake(() => { throw new Error("not on PATH"); });
    const libStub = (_pkg: string): string | null => "0.10.0"; // sibling global install
    const installed = probeBinVersion(binNull, "flair-mcp") ?? libStub("@tpsdev-ai/flair-mcp");
    expect(installed).toBe("0.10.0");
    expect(statusFor(installed, "0.16.0")).toBe("outdated");
    // …and not the false "missing" the bin-only probe produced before the fix.
    expect(statusFor(installed, "0.16.0")).not.toBe("missing");
  });

  test("a current flair-mcp via the lib fallback reports 'current'", () => {
    const binNull = fake(() => { throw new Error("not on PATH"); });
    const libStub = (_pkg: string): string | null => "0.16.0";
    const installed = probeBinVersion(binNull, "flair-mcp") ?? libStub("@tpsdev-ai/flair-mcp");
    expect(statusFor(installed, "0.16.0")).toBe("current");
  });

  test("genuinely-uninstalled flair-mcp (both probes null) is still 'missing'", () => {
    const binNull = fake(() => { throw new Error("not on PATH"); });
    const installed = probeBinVersion(binNull, "flair-mcp")
      ?? probeLibVersion("this-package-does-not-exist-anywhere-3f8c2a1b");
    expect(installed).toBeNull();
    expect(statusFor(installed, "0.16.0")).toBe("missing");
  });
});

// fix #2 (ops-p42n): the optional openclaw-flair line is suppressed in the
// default listing on machines without openclaw, but still shown under --all.
describe("shouldPrintUpgradeLine", () => {
  test("suppresses an optional (openclaw-absent) line by default", () => {
    expect(shouldPrintUpgradeLine("optional", false)).toBe(false);
  });

  test("shows the optional line under --all (showAll)", () => {
    expect(shouldPrintUpgradeLine("optional", true)).toBe(true);
  });

  test("always shows current / outdated / missing lines (default and --all)", () => {
    for (const showAll of [false, true]) {
      expect(shouldPrintUpgradeLine("current", showAll)).toBe(true);
      expect(shouldPrintUpgradeLine("outdated", showAll)).toBe(true);
      expect(shouldPrintUpgradeLine("missing", showAll)).toBe(true);
    }
  });
});
