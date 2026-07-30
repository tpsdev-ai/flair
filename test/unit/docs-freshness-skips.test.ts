// A skipped docs-freshness check must not render as a passing one (flair#953).
//
// The original defect was not in any check's logic. `cli-command-descriptions`
// printed "dist/cli.js not built — skipping", returned no failures, and the
// runner rendered `✓ pass` under a summary reading "All docs-freshness checks
// passed". Six checks, six ticks, one of them a lie — and the lie is invisible
// from the source of the check that told it, because it lives in the runner.
//
// So these tests are BEHAVIOUR tests: they build a throwaway repo, run the real
// script as a subprocess, and assert on stdout and the exit code — the two
// things a human or a CI step actually consumes. Asserting on the shape of the
// return value would have passed happily against the broken version, which
// returned a perfectly well-formed empty failure list.

import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_REL = join("scripts", "docs-freshness-check.mjs");

/**
 * A minimal repo the gate can run against end to end: a package.json to read the
 * name/version from, a src/cli.ts carrying DEFAULT_PORT, one prose doc, one
 * getting-started doc, a CHANGELOG with an [Unreleased] section, and a git
 * history with a v-tag so the changelog check has something to compare against.
 */
function makeFixture(opts: {
  quickstart?: boolean;
  git?: boolean;
  distCli?: string | null;
} = {}): string {
  const { quickstart = true, git = true, distCli = null } = opts;
  const dir = mkdtempSync(join(tmpdir(), "flair-docs-freshness-"));

  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["docs-freshness-check.mjs", "changelog-fragments.mjs"]) {
    cpSync(join(REPO_ROOT, "scripts", f), join(dir, "scripts", f));
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.1.0", private: true }, null, 2) + "\n",
  );

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), "const DEFAULT_PORT = 9927;\nexport { DEFAULT_PORT };\n");

  writeFileSync(join(dir, "README.md"), "# Fixture\n\nNothing stale in here.\n");

  mkdirSync(join(dir, "docs"), { recursive: true });
  if (quickstart) {
    writeFileSync(join(dir, "docs", "quickstart.md"), "# Quickstart\n\nInstall vX.Y.Z and go.\n");
  } else {
    // The corpus is an existsSync filter over a hardcoded path list. Renaming
    // the file empties it — the "examined zero items" variant of the same bug.
    writeFileSync(join(dir, "docs", "getting-started.md"), "# Renamed\n\nInstall vX.Y.Z and go.\n");
  }

  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2020-01-01\n\n### Added\n\n- Initial.\n",
  );
  mkdirSync(join(dir, ".changelog", "unreleased"), { recursive: true });

  if (distCli !== null) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli.js"), distCli);
  }

  if (git) {
    const g = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    g("init", "-q");
    g("config", "user.email", "fixture@example.invalid");
    g("config", "user.name", "Fixture");
    g("config", "commit.gpgsign", "false");
    g("add", "-A");
    g("commit", "-qm", "chore: fixture");
    g("tag", "v0.1.0");
  }

  return dir;
}

/** A dist/cli.js exporting a commander-shaped tree with `n` described commands. */
function fakeCli(n: number): string {
  const cmds = Array.from({ length: n }, (_, i) =>
    `{ name: () => "cmd${i}", description: () => "does thing ${i}", commands: [] }`,
  ).join(", ");
  return `export const program = { commands: [${cmds}] };\n`;
}

function runGate(dir: string) {
  const r = spawnSync(process.execPath, [join(dir, SCRIPT_REL)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const created: string[] = [];
function fixture(opts: Parameters<typeof makeFixture>[0] = {}): string {
  const d = makeFixture(opts);
  created.push(d);
  return d;
}

// ─── The control: the gate still works ────────────────────────────────────────

describe("docs-freshness gate, everything present", () => {
  let res: { status: number | null; out: string };
  beforeAll(() => {
    res = runGate(fixture({ distCli: fakeCli(3) }));
  });

  test("exits 0", () => {
    expect(res.status).toBe(0);
  });

  test("reports every check as passed", () => {
    expect(res.out).toContain("7/7 checks passed");
    expect(res.out).toContain("All 7 docs-freshness checks ran and passed.");
  });

  test("reports nothing as skipped", () => {
    expect(res.out).not.toContain("DID NOT RUN");
  });

  test("says how many items each corpus check examined", () => {
    // A pass with a count is falsifiable; a bare `✓ pass` is not. If a corpus
    // silently empties, this number is where it shows up.
    expect(res.out).toMatch(/prose docs scanned/);
    expect(res.out).toContain("3 CLI commands scanned");
  });
});

// ─── flair#953 itself ─────────────────────────────────────────────────────────

describe("cli-command-descriptions with dist/cli.js absent", () => {
  let res: { status: number | null; out: string };
  beforeAll(() => {
    res = runGate(fixture({ distCli: null }));
  });

  test("does not exit 0", () => {
    // The whole bug in one assertion: the gate used to exit 0 here.
    expect(res.status).not.toBe(0);
  });

  test("uses the did-not-run exit code, not the failure exit code", () => {
    expect(res.status).toBe(2);
  });

  test("marks the check as not having run", () => {
    expect(res.out).toContain("cli-command-descriptions");
    expect(res.out).toContain("DID NOT RUN");
  });

  test("names the remedy, which is not 'go fix your docs'", () => {
    expect(res.out).toContain("bun run build:cli");
  });

  test("never claims all checks passed", () => {
    expect(res.out).not.toContain("All 7 docs-freshness checks ran and passed.");
    expect(res.out).not.toMatch(/7\/7 checks passed/);
  });

  test("the tally excludes it from the pass count and names it separately", () => {
    expect(res.out).toContain("6/7 checks passed");
    expect(res.out).toContain("1 DID NOT RUN");
  });
});

// ─── The silent variant: a corpus that emptied ────────────────────────────────

describe("a check whose corpus is empty", () => {
  let res: { status: number | null; out: string };
  beforeAll(() => {
    // docs/quickstart.md renamed: GETTING_STARTED_DOCS filters down to [], the
    // loop body never runs, zero problems are found. Before flair#953 this was
    // byte-identical to a healthy scan.
    res = runGate(fixture({ quickstart: false, distCli: fakeCli(3) }));
  });

  test("does not exit 0", () => {
    expect(res.status).not.toBe(0);
  });

  test("reports the getting-started check as not having run", () => {
    expect(res.out).toMatch(/getting-started-version-placeholder[\s\S]*?DID NOT RUN/);
  });

  test("says the input set was empty rather than implying a clean scan", () => {
    expect(res.out).toContain("examined 0 getting-started docs");
  });
});

describe("a CLI that registers no commands", () => {
  let res: { status: number | null; out: string };
  beforeAll(() => {
    // dist/cli.js builds and exports `program`, but the command tree is empty:
    // zero commands walked, zero missing descriptions found.
    res = runGate(fixture({ distCli: "export const program = { commands: [] };\n" }));
  });

  test("does not exit 0", () => {
    expect(res.status).not.toBe(0);
  });

  test("reports that it examined nothing", () => {
    expect(res.out).toContain("examined 0 CLI commands");
  });
});

// ─── The other swallow in the same file ───────────────────────────────────────

describe("changelog-unreleased with no git history", () => {
  let res: { status: number | null; out: string };
  beforeAll(() => {
    res = runGate(fixture({ git: false, distCli: fakeCli(3) }));
  });

  test("does not exit 0", () => {
    expect(res.status).not.toBe(0);
  });

  test("reports the check as not having run rather than warning and passing", () => {
    expect(res.out).toMatch(/changelog-unreleased[\s\S]*?DID NOT RUN/);
  });

  test("names what specifically went unchecked", () => {
    expect(res.out).toContain("NOT checked");
  });
});

// ─── The gate itself must not be able to shrink silently ──────────────────────

describe("the check manifest", () => {
  test("every expected check is registered, and the count is asserted", () => {
    // A gate that registers zero checks reports success exactly as loudly as one
    // that registers six. EXPECTED_CHECKS is the contract that makes losing a
    // check an error rather than a quiet reduction in coverage.
    const src = Bun.file(join(REPO_ROOT, SCRIPT_REL));
    return src.text().then((text) => {
      const block = text.slice(text.indexOf("const EXPECTED_CHECKS"), text.indexOf("];", text.indexOf("const EXPECTED_CHECKS")));
      const expected = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
      const defined = [...text.matchAll(/defineCheck\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
      expect(expected.length).toBeGreaterThan(0);
      expect(defined.sort()).toEqual(expected.sort());
    });
  });

  test("the runner refuses to report when a check failed to register", () => {
    const dir = fixture({ distCli: fakeCli(3) });
    const path = join(dir, SCRIPT_REL);
    const src = Bun.file(path);
    return src.text().then(async (text) => {
      // Disable one check's registration the way a bad merge would.
      const broken = text.replace('defineCheck("port-drift"', 'const _dropped = ((...a) => a)(\n  "port-drift"');
      expect(broken).not.toBe(text);
      writeFileSync(path, broken);
      const res = runGate(dir);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("gate is incomplete");
      expect(res.out).toContain("port-drift");
    });
  });
});

describe("cleanup", () => {
  test("removes fixtures", () => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
