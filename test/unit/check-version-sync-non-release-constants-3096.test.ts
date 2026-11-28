import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  declaresVersion,
  NON_RELEASE_VERSION_CONSTANTS,
  VERSION_DECLARATION,
} from "../../scripts/check-version-sync.mjs";

function scratchDir(): string {
  const dir = join(
    tmpdir(),
    `flair-check-version-sync-3096-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const REAL_ROOT = resolve(import.meta.dir, "../..");
const CHECKER_PATH = join(REAL_ROOT, "scripts", "check-version-sync.mjs");
const REAL_VERSION = JSON.parse(readFileSync(join(REAL_ROOT, "package.json"), "utf8")).version;

function getTestEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return process.env;
  }
  try {
    const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (probe.status === 0 && !String(probe.stderr ?? "").includes("WindowsApps")) {
      return process.env;
    }
  } catch {}

  const wherePython = spawnSync("where.exe", ["python"], { encoding: "utf8" });
  const lines = String(wherePython.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const realPython = lines.find((p) => !p.includes("WindowsApps"));
  if (realPython) {
    const shimDir = join(tmpdir(), "flair-python3-shim");
    mkdirSync(shimDir, { recursive: true });
    const targetExe = join(shimDir, "python3.exe");
    if (!existsSync(targetExe)) {
      copyFileSync(realPython, targetExe);
    }
    return {
      ...process.env,
      PATH: `${shimDir};${process.env.PATH ?? ""}`,
    };
  }
  return process.env;
}

const TEST_ENV = getTestEnv();

function setupScratchTree(): { root: string; cleanup: () => void } {
  const root = scratchDir();
  // Read inventory from real checker
  const listed = spawnSync(process.execPath, [CHECKER_PATH, "--list"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
    env: TEST_ENV,
  });
  expect(listed.status).toBe(0);
  const inventory = String(listed.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const rel of inventory) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(REAL_ROOT, rel)));
  }

  // Also copy pyproject helper needed by the checker
  mkdirSync(join(root, "scripts", "ci"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "ci", "pyproject-version.mjs"),
    readFileSync(join(REAL_ROOT, "scripts", "ci", "pyproject-version.mjs")),
  );

  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("check-version-sync: non-release version constants (#3096)", () => {
  describe("VERSION_DECLARATION and declaresVersion", () => {
    test("captures identifier and version in regex groups", () => {
      const text = 'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";';
      const matches = [...text.matchAll(VERSION_DECLARATION)];
      expect(matches.length).toBe(1);
      expect(matches[0][1]).toBe("CANDIDATE_LIST_MIN_SERVER_VERSION");
      expect(matches[0][2]).toBe("0.63.0");
    });

    test("declaresVersion returns false when identifier is listed in nonReleaseConstants", () => {
      const text = 'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";';
      const allowlist = [
        {
          file: "src/rem/restore.ts",
          identifier: "CANDIDATE_LIST_MIN_SERVER_VERSION",
          reason: "Server-capability minimum, not a package version",
        },
      ];
      const hasDeclaration = declaresVersion("src/rem/restore.ts", text, "0.63.0", allowlist);
      expect(hasDeclaration).toBe(false);
    });

    test("declaresVersion returns true when identifier is not listed", () => {
      const text = 'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";';
      const hasDeclaration = declaresVersion("src/rem/restore.ts", text, "0.63.0", []);
      expect(hasDeclaration).toBe(true);
    });

    test("declaresVersion returns false when version does not match expected", () => {
      const text = 'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.62.0";';
      const hasDeclaration = declaresVersion("src/rem/restore.ts", text, "0.63.0", []);
      expect(hasDeclaration).toBe(false);
    });

    test("declaresVersion flags unlisted declaration even if another declaration in same file is listed", () => {
      const text = [
        'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";',
        'export const UNKNOWN_VERSION = "0.63.0";',
      ].join("\n");
      const allowlist = [
        {
          file: "src/rem/restore.ts",
          identifier: "CANDIDATE_LIST_MIN_SERVER_VERSION",
          reason: "Server-capability minimum",
        },
      ];
      const hasDeclaration = declaresVersion("src/rem/restore.ts", text, "0.63.0", allowlist);
      expect(hasDeclaration).toBe(true);
    });
  });

  describe("CLI verification against tree", () => {
    test("a listed constant is skipped and passes the check", () => {
      const { root, cleanup } = setupScratchTree();
      try {
        mkdirSync(join(root, "src", "rem"), { recursive: true });
        writeFileSync(
          join(root, "src", "rem", "restore.ts"),
          'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";\n',
        );

        const allowlistJson = JSON.stringify([
          {
            file: "src/rem/restore.ts",
            identifier: "CANDIDATE_LIST_MIN_SERVER_VERSION",
            reason: "Server-capability minimum, not a release declaration",
          },
        ]);

        const r = spawnSync(
          process.execPath,
          [
            CHECKER_PATH,
            "0.63.0",
            "--root",
            root,
            "--non-release-constants",
            allowlistJson,
          ],
          { encoding: "utf8", env: TEST_ENV },
        );

        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, `check should exit 0 on listed constant. Output: ${out}`).toBe(0);
        expect(out).toContain("consistent across");
        expect(out).not.toContain("these files declare version");
      } finally {
        cleanup();
      }
    });

    test("an unlisted constant of the same shape fails the check", () => {
      const { root, cleanup } = setupScratchTree();
      try {
        mkdirSync(join(root, "src", "rem"), { recursive: true });
        writeFileSync(
          join(root, "src", "rem", "restore.ts"),
          'export const CANDIDATE_LIST_MIN_SERVER_VERSION = "0.63.0";\n',
        );

        // Run with empty allowlist
        const r = spawnSync(
          process.execPath,
          [
            CHECKER_PATH,
            "0.63.0",
            "--root",
            root,
            "--non-release-constants",
            "[]",
          ],
          { encoding: "utf8", env: TEST_ENV },
        );

        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, `check should fail on unlisted constant. Output: ${out}`).not.toBe(0);
        expect(out).toContain("these files declare version 0.63.0 but the release script does not bump them:");
        expect(out).toContain("src/rem/restore.ts");
      } finally {
        cleanup();
      }
    });

    test("a stale entry whose identifier no longer exists in its file fails the check", () => {
      const { root, cleanup } = setupScratchTree();
      try {
        mkdirSync(join(root, "src", "rem"), { recursive: true });
        // File exists, but the constant was renamed or deleted
        writeFileSync(
          join(root, "src", "rem", "restore.ts"),
          'export const CANDIDATE_LIST_FIRST_SERVER_RELEASE = "0.63.0";\n',
        );

        const allowlistJson = JSON.stringify([
          {
            file: "src/rem/restore.ts",
            identifier: "CANDIDATE_LIST_MIN_SERVER_VERSION",
            reason: "Server-capability minimum",
          },
        ]);

        const r = spawnSync(
          process.execPath,
          [
            CHECKER_PATH,
            "0.63.0",
            "--root",
            root,
            "--non-release-constants",
            allowlistJson,
          ],
          { encoding: "utf8", env: TEST_ENV },
        );

        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, `check should fail on stale entry. Output: ${out}`).not.toBe(0);
        expect(out).toContain('stale non-release constant: "CANDIDATE_LIST_MIN_SERVER_VERSION" was not found in src/rem/restore.ts');
      } finally {
        cleanup();
      }
    });

    test("a stale entry whose file does not exist fails the check", () => {
      const { root, cleanup } = setupScratchTree();
      try {
        const allowlistJson = JSON.stringify([
          {
            file: "src/rem/nonexistent.ts",
            identifier: "SOME_MIN_SERVER_VERSION",
            reason: "Nonexistent file check",
          },
        ]);

        const r = spawnSync(
          process.execPath,
          [
            CHECKER_PATH,
            "0.63.0",
            "--root",
            root,
            "--non-release-constants",
            allowlistJson,
          ],
          { encoding: "utf8", env: TEST_ENV },
        );

        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, `check should fail on nonexistent file entry. Output: ${out}`).not.toBe(0);
        expect(out).toContain('non-release constant "SOME_MIN_SERVER_VERSION" in src/rem/nonexistent.ts could not be read or does not exist');
      } finally {
        cleanup();
      }
    });
  });
});
