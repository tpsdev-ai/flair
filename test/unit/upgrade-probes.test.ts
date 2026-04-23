import { describe, test, expect } from "bun:test";
import { probeBinVersion, probeLibVersion } from "../../src/cli";

describe("probeBinVersion", () => {
  test("returns the parsed semver when the binary prints a version string", () => {
    const fake = ((_cmd: string, _opts?: any) => "0.6.0\n") as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBe("0.6.0");
  });

  test("handles a version embedded in a longer line (e.g., 'flair 0.6.0 (abc)')", () => {
    const fake = ((_cmd: string, _opts?: any) => "flair 0.6.0 (rev abc)\n") as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBe("0.6.0");
  });

  test("handles pre-release / rc versions", () => {
    const fake = ((_cmd: string, _opts?: any) => "1.0.0-rc.1\n") as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBe("1.0.0-rc.1");
  });

  test("returns null when the binary isn't installed (execSync throws)", () => {
    const fake = ((_cmd: string, _opts?: any) => { throw new Error("command not found: flair"); }) as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBeNull();
  });

  test("returns null when the binary produces no version string", () => {
    const fake = ((_cmd: string, _opts?: any) => "no version info here\n") as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBeNull();
  });

  test("returns null on empty stdout", () => {
    const fake = ((_cmd: string, _opts?: any) => "") as unknown as typeof import("node:child_process").execSync;
    expect(probeBinVersion(fake, "flair")).toBeNull();
  });
});

describe("probeLibVersion", () => {
  test("resolves a package that's in the running module graph", () => {
    // js-yaml is a direct dep of @tpsdev-ai/flair; guaranteed resolvable here.
    const version = probeLibVersion("js-yaml");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("returns null for a package that's not installed anywhere Node can find it", () => {
    const version = probeLibVersion("this-package-does-not-exist-anywhere-3f8c2a1b");
    expect(version).toBeNull();
  });
});
