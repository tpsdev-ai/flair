import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { tempDir } from "../helpers/temp-dir.js";
import {
  checkGlobalBinOnPath,
  cliBootPathWarning,
  isDirOnPath,
  postinstallWarning,
} from "../../src/install/global-bin-path.js";

// Each PATH is passed explicitly: no ambient PATH, shell, npm, or Flair install.
// Canonicalize the scratch root so the only aliases under test are our fixtures.
function fixture() {
  const root = realpathSync(tempDir("flair-global-bin-symlinks-"));
  const prefix = join(root, "node", "24.19.0");
  const aliasPrefix = join(root, "node", "24");
  const win32 = process.platform === "win32";
  const linkType = win32 ? "junction" : "dir";
  const binDir = win32 ? prefix : join(prefix, "bin");
  const aliasBin = win32 ? aliasPrefix : join(aliasPrefix, "bin");
  const packageSuffix = win32
    ? ["node_modules", "@tpsdev-ai", "flair"]
    : ["lib", "node_modules", "@tpsdev-ai", "flair"];

  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(prefix, ...packageSuffix), { recursive: true });
  writeFileSync(join(binDir, win32 ? "flair.cmd" : "flair"), "", { mode: 0o755 });
  symlinkSync(prefix, aliasPrefix, linkType);

  const directAlias = join(root, "alias-bin");
  symlinkSync(binDir, directAlias, linkType);
  const broken = join(root, "broken");
  symlinkSync(join(root, "missing"), broken, linkType);
  const other = join(root, "other");
  mkdirSync(other);

  return {
    prefix,
    binDir,
    aliasBin,
    directAlias,
    broken,
    other,
    // Model Node reporting the package location after following the alias.
    packageDir: realpathSync(join(aliasPrefix, ...packageSuffix)),
  };
}

describe("global bin PATH symlinks (flair#2034 part 1)", () => {
  test("a plain directory still matches, including trailing separators", () => {
    const f = fixture();
    expect(isDirOnPath(f.binDir, [f.other, f.binDir].join(delimiter))).toBe(true);
    expect(isDirOnPath(f.binDir + sep, f.binDir + sep)).toBe(true);
    expect(isDirOnPath(f.binDir, f.other)).toBe(false);
  });

  test("a version alias and a direct bin symlink count as on PATH", () => {
    const f = fixture();
    expect(f.aliasBin).not.toBe(f.binDir);
    expect(realpathSync(f.aliasBin)).toBe(realpathSync(f.binDir));
    expect(isDirOnPath(f.binDir, [f.other, f.aliasBin].join(delimiter))).toBe(true);
    expect(isDirOnPath(f.binDir, f.directAlias + sep)).toBe(true);
  });

  test("the requested directory is also resolved", () => {
    const f = fixture();
    expect(isDirOnPath(f.aliasBin, f.binDir)).toBe(true);
    expect(isDirOnPath(f.aliasBin, f.directAlias)).toBe(true);
  });

  test("a broken entry is tolerated and does not hide a later alias", () => {
    const f = fixture();
    expect(isDirOnPath(f.binDir, [f.broken, f.other].join(delimiter))).toBe(false);
    expect(isDirOnPath(f.binDir, [f.broken, f.aliasBin].join(delimiter))).toBe(true);
    expect(isDirOnPath(f.broken, f.other)).toBe(false);
  });

  test("empty PATH entries and a missing PATH do not match", () => {
    const f = fixture();
    expect(isDirOnPath(f.binDir, undefined)).toBe(false);
    expect(isDirOnPath(f.binDir, "")).toBe(false);
    expect(isDirOnPath(f.binDir, delimiter + f.other + delimiter)).toBe(false);
    expect(isDirOnPath("", f.aliasBin)).toBe(false);
  });

  test.each(["/bin/fish", "/bin/zsh", "/bin/bash"])(
    "the CLI omits version-pinning advice for an alias on PATH (%s)",
    (shell) => {
      const f = fixture();
      const env = { packageDir: f.packageDir, shell, stderrIsTTY: true };

      // Positive control: same real fixture, validation and TTY gates enabled.
      const offPath = cliBootPathWarning({ ...env, pathEnv: f.other });
      expect(offPath).not.toBeNull();
      expect(offPath ?? "").toContain("fix now:");
      expect(offPath ?? "").toContain(f.binDir);

      const onPath = cliBootPathWarning({
        ...env,
        pathEnv: [f.broken, f.aliasBin].join(delimiter),
      });
      expect(onPath ?? "").not.toContain("fix now:");
      expect(onPath).toBeNull();
    },
  );

  test("doctor and postinstall also accept the alias without fix advice", () => {
    const f = fixture();
    const pathEnv = [f.broken, f.aliasBin].join(delimiter);
    expect(checkGlobalBinOnPath({ prefix: f.prefix, pathEnv })).toEqual({
      onPath: true,
      binDir: f.binDir,
    });
    const env = {
      npmConfigGlobal: "true",
      packageDir: f.packageDir,
      shell: "/bin/fish",
    };
    expect(postinstallWarning({ ...env, pathEnv: f.other }) ?? "")
      .toContain("fish_add_path " + f.binDir);
    expect(postinstallWarning({ ...env, pathEnv })).toBeNull();
  });
});
