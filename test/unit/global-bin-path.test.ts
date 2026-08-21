/**
 * global-bin-path.test.ts — flair#1134: `npm i -g` on a user-prefix setup
 * (prefix = ~/.npm-global) succeeds and then `flair` is command-not-found,
 * because <prefix>/bin never made it into PATH while the docs claim
 * one-command readiness.
 *
 * Covers the detection helper (prefix-in-PATH true/false, trailing-slash
 * edges, win32 shapes), the message contract (names the ACTUAL bin dir and
 * the exact export line — never "check your PATH"), the postinstall
 * decision (global-only, validated-dir-only), and the real execution path
 * of the postinstall entry (spawned, detached so /dev/tty is deterministically
 * absent and the stderr fallback is what's under test).
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  npmGlobalBinDir,
  isDirOnPath,
  shellPathFix,
  formatOffPathMessage,
  formatCompactOffPathBanner,
  checkGlobalBinOnPath,
  cliBootPathWarning,
  postinstallWarning,
  prefixFromPackageDir,
} from "../../src/install/global-bin-path.js";

const BIN = "/Users/casey/.npm-global/bin";

// ─── npmGlobalBinDir ────────────────────────────────────────────────────────

describe("npmGlobalBinDir", () => {
  test("posix: <prefix>/bin", () => {
    expect(npmGlobalBinDir("/Users/casey/.npm-global", "darwin")).toBe(BIN);
  });

  test("posix: trailing slash on the prefix is stripped first", () => {
    expect(npmGlobalBinDir("/Users/casey/.npm-global/", "linux")).toBe(BIN);
    expect(npmGlobalBinDir("/Users/casey/.npm-global///", "linux")).toBe(BIN);
  });

  test("win32: bins land in the prefix itself, not prefix/bin", () => {
    expect(npmGlobalBinDir("C:\\Users\\casey\\npm", "win32")).toBe("C:\\Users\\casey\\npm");
    expect(npmGlobalBinDir("C:\\Users\\casey\\npm\\", "win32")).toBe("C:\\Users\\casey\\npm");
  });
});

// ─── isDirOnPath ────────────────────────────────────────────────────────────

describe("isDirOnPath", () => {
  test("present → true", () => {
    expect(isDirOnPath(BIN, `/usr/bin:${BIN}:/bin`, "darwin")).toBe(true);
  });

  test("absent → false", () => {
    expect(isDirOnPath(BIN, "/usr/bin:/bin:/usr/local/bin", "darwin")).toBe(false);
  });

  test("edge: trailing slash on the PATH entry still matches", () => {
    expect(isDirOnPath(BIN, `/usr/bin:${BIN}/:/bin`, "darwin")).toBe(true);
  });

  test("edge: trailing slash on the dir argument still matches", () => {
    expect(isDirOnPath(`${BIN}/`, `/usr/bin:${BIN}:/bin`, "darwin")).toBe(true);
  });

  test("undefined or empty PATH → false, never a throw", () => {
    expect(isDirOnPath(BIN, undefined, "darwin")).toBe(false);
    expect(isDirOnPath(BIN, "", "darwin")).toBe(false);
  });

  test("empty PATH entries (::) are ignored, not matched", () => {
    expect(isDirOnPath(BIN, `/usr/bin::${BIN}`, "darwin")).toBe(true);
    expect(isDirOnPath("", "/usr/bin::/bin", "darwin")).toBe(false);
  });

  test("a PREFIX of a PATH entry is not a match", () => {
    expect(isDirOnPath(BIN, `${BIN}x:/usr/bin`, "darwin")).toBe(false);
    expect(isDirOnPath(BIN, `${BIN}/deeper:/usr/bin`, "darwin")).toBe(false);
  });

  test("win32: ';' delimiter, case-insensitive, either separator", () => {
    const dir = "C:\\Users\\casey\\npm";
    expect(isDirOnPath(dir, "C:\\Windows;c:\\users\\casey\\NPM", "win32")).toBe(true);
    expect(isDirOnPath(dir, "C:\\Windows;C:/Users/casey/npm", "win32")).toBe(true);
    expect(isDirOnPath(dir, "C:\\Windows;C:\\Users\\casey", "win32")).toBe(false);
  });
});

// ─── shellPathFix ───────────────────────────────────────────────────────────

describe("shellPathFix", () => {
  test("zsh → export line + ~/.zshrc persist", () => {
    const fix = shellPathFix(BIN, "/bin/zsh");
    expect(fix.exportLine).toBe(`export PATH="${BIN}:$PATH"`);
    expect(fix.rcFile).toBe("~/.zshrc");
    expect(fix.persistCommand).toBe(`echo 'export PATH="${BIN}:$PATH"' >> ~/.zshrc`);
  });

  test("bash → ~/.bashrc", () => {
    expect(shellPathFix(BIN, "/usr/bin/bash").rcFile).toBe("~/.bashrc");
  });

  test("fish → fish_add_path is both the fix and the persist", () => {
    const fix = shellPathFix(BIN, "/opt/homebrew/bin/fish");
    expect(fix.exportLine).toBe(`fish_add_path ${BIN}`);
    expect(fix.persistCommand).toBe(fix.exportLine);
  });

  test("unknown or absent shell → export line, no invented rc file", () => {
    for (const shell of ["/bin/dash", undefined]) {
      const fix = shellPathFix(BIN, shell);
      expect(fix.exportLine).toBe(`export PATH="${BIN}:$PATH"`);
      expect(fix.rcFile).toBeNull();
      expect(fix.persistCommand).toBeNull();
    }
  });
});

// ─── message contract: names the dir, gives the exact line ──────────────────

describe("formatOffPathMessage", () => {
  test("names the ACTUAL bin dir and the exact export line (zsh)", () => {
    const msg = formatOffPathMessage(BIN, "/bin/zsh", "darwin");
    expect(msg).toContain(BIN);
    expect(msg).toContain(`export PATH="${BIN}:$PATH"`);
    expect(msg).toContain("~/.zshrc");
    expect(msg).toContain("flair --version"); // enables verification, not just hope
    expect(msg.toLowerCase()).not.toContain("check your path"); // the anti-goal
  });

  test("fish variant uses fish_add_path", () => {
    const msg = formatOffPathMessage(BIN, "/usr/bin/fish", "linux");
    expect(msg).toContain(`fish_add_path ${BIN}`);
    expect(msg).not.toContain(".zshrc");
  });

  test("unknown shell still gives a runnable line plus honest persist wording", () => {
    const msg = formatOffPathMessage(BIN, undefined, "linux");
    expect(msg).toContain(`export PATH="${BIN}:$PATH"`);
    expect(msg).toContain("startup file");
  });

  test("win32 names the dir and a concrete setx-equivalent command", () => {
    const dir = "C:\\Users\\casey\\npm";
    const msg = formatOffPathMessage(dir, undefined, "win32");
    expect(msg).toContain(dir);
    expect(msg).toContain("SetEnvironmentVariable");
    expect(msg).toContain("flair --version");
  });
});

// ─── checkGlobalBinOnPath (doctor's entry point) ────────────────────────────

describe("checkGlobalBinOnPath", () => {
  test("prefix's bin dir on PATH → onPath true with the dir named", () => {
    const res = checkGlobalBinOnPath({
      prefix: "/Users/casey/.npm-global",
      pathEnv: `/usr/bin:${BIN}`,
      shell: "/bin/zsh",
      platform: "darwin",
    });
    expect(res.onPath).toBe(true);
    expect(res.binDir).toBe(BIN);
  });

  test("off PATH → message carries dir + export line", () => {
    const res = checkGlobalBinOnPath({
      prefix: "/Users/casey/.npm-global",
      pathEnv: "/usr/bin:/bin",
      shell: "/bin/zsh",
      platform: "darwin",
    });
    if (res.onPath) throw new Error("expected off-PATH result");
    expect(res.binDir).toBe(BIN);
    expect(res.exportLine).toBe(`export PATH="${BIN}:$PATH"`);
    expect(res.message).toContain(BIN);
    expect(res.message).toContain(res.exportLine);
  });

  test("edge: trailing slash on the configured prefix still matches PATH", () => {
    const res = checkGlobalBinOnPath({
      prefix: "/Users/casey/.npm-global/",
      pathEnv: `${BIN}:/usr/bin`,
      platform: "darwin",
    });
    expect(res.onPath).toBe(true);
  });
});

// ─── postinstallWarning (decision logic) ────────────────────────────────────

describe("postinstallWarning", () => {
  const base = {
    npmConfigGlobal: "true",
    npmConfigPrefix: "/Users/casey/.npm-global",
    pathEnv: "/usr/bin:/bin",
    shell: "/bin/zsh",
    platform: "darwin" as const,
    binDirHasFlair: (d: string) => d === BIN,
  };

  test("not a global install → silent, even when off PATH", () => {
    expect(postinstallWarning({ ...base, npmConfigGlobal: undefined })).toBeNull();
    expect(postinstallWarning({ ...base, npmConfigGlobal: "false" })).toBeNull();
  });

  test("global + off PATH + validated dir → the actionable message", () => {
    const msg = postinstallWarning(base);
    expect(msg).not.toBeNull();
    expect(msg!).toContain(BIN);
    expect(msg!).toContain(`export PATH="${BIN}:$PATH"`);
  });

  test("global + on PATH → silent", () => {
    expect(postinstallWarning({ ...base, pathEnv: `/usr/bin:${BIN}` })).toBeNull();
  });

  test("dir does not validate (no flair bin there) → silent, never a wrong fix", () => {
    expect(postinstallWarning({ ...base, binDirHasFlair: () => false })).toBeNull();
  });

  test("no npm_config_prefix → prefix derived from the package's own location", () => {
    const msg = postinstallWarning({
      ...base,
      npmConfigPrefix: undefined,
      packageDir: "/Users/casey/.npm-global/lib/node_modules/@tpsdev-ai/flair",
    });
    expect(msg).not.toBeNull();
    expect(msg!).toContain(BIN);
  });
});

// ─── cliBootPathWarning (the surface that runs when lifecycle scripts can't) ─

describe("cliBootPathWarning", () => {
  const base = {
    packageDir: "/Users/casey/.npm-global/lib/node_modules/@tpsdev-ai/flair",
    pathEnv: "/usr/bin:/bin",
    shell: "/bin/zsh",
    platform: "darwin" as const,
    stderrIsTTY: true,
    binDirHasFlair: (d: string) => d === BIN,
  };

  test("TTY + validated + off PATH → compact banner with dir and export line", () => {
    const banner = cliBootPathWarning(base);
    expect(banner).not.toBeNull();
    expect(banner!).toContain(BIN);
    expect(banner!).toContain(`export PATH="${BIN}:$PATH"`);
  });

  test("no TTY → silent, regardless of PATH state (automation noise gate)", () => {
    expect(cliBootPathWarning({ ...base, stderrIsTTY: false })).toBeNull();
  });

  test("bin dir on PATH → silent", () => {
    expect(cliBootPathWarning({ ...base, pathEnv: `/usr/bin:${BIN}` })).toBeNull();
  });

  test("layout does not validate (dev checkout / npx cache) → silent", () => {
    expect(cliBootPathWarning({ ...base, binDirHasFlair: () => false })).toBeNull();
    // A real dev-checkout shape: chopping four segments off the repo root
    // lands somewhere with no flair bin, so the default validator refuses.
    expect(
      cliBootPathWarning({ ...base, packageDir: "/Users/casey/ops/flair", binDirHasFlair: undefined }),
    ).toBeNull();
  });
});

describe("formatCompactOffPathBanner", () => {
  test("zsh: fix line + separate persist line", () => {
    const b = formatCompactOffPathBanner(BIN, "/bin/zsh");
    expect(b).toContain(`export PATH="${BIN}:$PATH"`);
    expect(b).toContain("~/.zshrc");
  });

  test("fish: fix IS the persist — no duplicate line", () => {
    const b = formatCompactOffPathBanner(BIN, "/usr/bin/fish");
    expect(b).toContain(`fish_add_path ${BIN}`);
    expect(b).not.toContain("persist:");
  });

  test("unknown shell: still names the dir and a runnable line", () => {
    const b = formatCompactOffPathBanner(BIN, undefined);
    expect(b).toContain(BIN);
    expect(b).toContain(`export PATH="${BIN}:$PATH"`);
    expect(b).toContain("startup file");
  });
});

describe("prefixFromPackageDir", () => {
  test("posix: four segments up from the package root", () => {
    expect(
      prefixFromPackageDir("/Users/casey/.npm-global/lib/node_modules/@tpsdev-ai/flair", "darwin"),
    ).toBe("/Users/casey/.npm-global");
  });

  test("win32: three segments up from the package root", () => {
    expect(
      prefixFromPackageDir("C:\\Users\\casey\\npm\\node_modules\\@tpsdev-ai\\flair", "win32"),
    ).toBe("C:\\Users\\casey\\npm");
  });
});

// ─── the postinstall ENTRY, actually executed ───────────────────────────────
//
// spawn the .cts entry the way npm would run the compiled .cjs: env-driven,
// no arguments, must always exit 0. FLAIR_POSTINSTALL_NO_TTY pins the entry
// to its stderr fallback — otherwise a suite run from a real terminal would
// have /dev/tty succeed, scribbling on the screen and blanking the stderr
// under assertion. The tty branch's coverage is the manual pty verification
// (`script`-wrapped npm i -g) recorded in the flair#1134 PR.

describe("postinstall entry (spawned)", () => {
  const entry = join(import.meta.dir, "..", "..", "src", "postinstall.cts");

  function runEntry(env: Record<string, string | undefined>) {
    const res = spawnSync(process.execPath, [entry], {
      env: { ...env, PATH: env.PATH ?? "/usr/bin:/bin", FLAIR_POSTINSTALL_NO_TTY: "1" },
      encoding: "utf-8",
      timeout: 15000,
    });
    return res;
  }

  function scratchPrefix(): string {
    const prefix = mkdtempSync(join(tmpdir(), "flair-1134-prefix-"));
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(prefix, "bin", "flair"), "#!/bin/sh\n", { mode: 0o755 });
    return prefix;
  }

  test("global install, bin dir off PATH → warns on stderr with the dir, exit 0", () => {
    const prefix = scratchPrefix();
    try {
      const res = runEntry({
        npm_config_global: "true",
        npm_config_prefix: prefix,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toContain(join(prefix, "bin"));
      expect(res.stderr).toContain(`export PATH="${join(prefix, "bin")}:$PATH"`);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("global install, bin dir ON PATH → silent, exit 0", () => {
    const prefix = scratchPrefix();
    try {
      const res = runEntry({
        npm_config_global: "true",
        npm_config_prefix: prefix,
        PATH: `/usr/bin:/bin:${join(prefix, "bin")}`,
        SHELL: "/bin/zsh",
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("local (non-global) install → silent, exit 0", () => {
    const prefix = scratchPrefix();
    try {
      const res = runEntry({
        npm_config_prefix: prefix,
        PATH: "/usr/bin:/bin",
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});
