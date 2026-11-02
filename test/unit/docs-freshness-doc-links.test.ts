// Non-exempt local Markdown references in shipped docs are checked against the npm pack file list (flair#2888).
//
// These are behaviour tests: each fixture is a real package directory (its own
// package.json `files` list, docs and, where the case needs one, a prepack that
// fails), and the gate runs as a subprocess against it. The assertions are on the
// gate's own output — the `file:line` it prints and whether the check reported a
// pass — because that is what a contributor reads and what CI keys on.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT_REL = join("scripts", "docs-freshness-check.mjs");
const SCRIPT_FILES = [
  "docs-freshness-check.mjs",
  "changelog-fragments.mjs",
  "changelog-release-notes.mjs",
  "changelog-extract.mjs",
  "published-paths.mjs",
];

const created: string[] = [];

/**
 * A throwaway package directory the whole gate can run against: package.json
 * with a `files` list, one topic doc, a schema + API reference so the other
 * checks stay quiet, and a git history with a v-tag.
 *
 * `docs` maps a path relative to the fixture root to its content and is written
 * verbatim, so a case controls every line number the gate reports.
 */
function makeFixture(opts: {
  files?: string[];
  docs: Record<string, string>;
  prepack?: string;
}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flair-doc-links-")));
  created.push(dir);

  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of SCRIPT_FILES) {
    cpSync(join(REPO_ROOT, "scripts", f), join(dir, "scripts", f));
  }

  const pkg: Record<string, unknown> = {
    name: "@tpsdev-ai/flair",
    version: "0.1.0",
    private: true,
    files: opts.files ?? ["docs/"],
  };
  if (opts.prepack) pkg.scripts = { prepack: opts.prepack };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), "const DEFAULT_PORT = 9927;\nexport { DEFAULT_PORT };\n");

  mkdirSync(join(dir, "schemas"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  // A described command tree and a getting-started doc: with these the gate has
  // every check it can run, so its exit code means "clean" or "a check failed"
  // rather than "something did not run".
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "dist", "cli.js"),
    "export const program = { commands: [{ name: () => \"cmd0\", description: () => \"does thing 0\", commands: [] }] };\n",
  );
  writeFileSync(join(dir, "docs", "quickstart.md"), "# Quickstart\n\nInstall vX.Y.Z and go.\n");
  writeFileSync(
    join(dir, "schemas", "memory.graphql"),
    "type Memory @table(database: \"flair\") {\n  id: ID @primaryKey\n}\n",
  );
  writeFileSync(join(dir, "docs", "api-reference.md"), "# API\n\nMemory is the agent memory table.\n");

  for (const [rel, body] of Object.entries(opts.docs)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }

  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2020-01-01\n\n### Added\n\n- Initial.\n",
  );
  mkdirSync(join(dir, ".changelog", "unreleased"), { recursive: true });

  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "fixture@example.invalid");
  g("config", "user.name", "Fixture");
  g("config", "commit.gpgsign", "false");
  g("add", "-A");
  const tree = g("write-tree").toString().trim();
  const commit = g("commit-tree", tree, "-m", "chore: fixture").toString().trim();
  g("update-ref", "HEAD", commit);
  g("tag", "v0.1.0");

  return dir;
}

function runGate(dir: string) {
  const r = spawnSync(process.execPath, [join(dir, SCRIPT_REL)], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The gate's summary line for the check under test. */
function summaryLine(out: string): string {
  return out.split("\n").find((l) => /(✓|✗|⊘) doc-link-pack-coverage/.test(l)) ?? "<no summary line>";
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("doc-link-pack-coverage", () => {
  const missingLinks = [
    ["inline", "See [design](../notes/missing.md).", "../notes/missing.md", 3],
    ["full reference", "See [design][target].\n\n[target]: ../notes/missing.md", "../notes/missing.md", 3],
    ["collapsed reference", "See [target][].\n\n[target]: ../notes/missing.md", "../notes/missing.md", 3],
    ["shortcut reference", "See [target].\n\n[target]: ../notes/missing.md", "../notes/missing.md", 3],
    ["multiline inline destination", "See [design](\n  ../notes/missing.md).", "../notes/missing.md", 3],
    ["multiline reference destination", "See [target].\n\n[target]:\n  ../notes/missing.md", "../notes/missing.md", 3],
    ["angle destination with spaces", "See [design](<../notes/missing file.md>).", "../notes/missing file.md", 3],
    ["inline title", "See [design](../notes/missing.md \"Design\").", "../notes/missing.md", 3],
    ["nested label", "See [nested [design]](../notes/missing.md).", "../notes/missing.md", 3],
    ["escaped space destination", "See [design](../notes/missing\\ file.md).", "../notes/missing file.md", 3],
  ] as const;

  for (const [form, reference, target, line] of missingLinks) {
    test(`${form} missing target fails at the reference line`, () => {
      const dir = makeFixture({ docs: { "docs/a.md": `# A\n\n${reference}\n` } });
      const { status, out } = runGate(dir);
      expect(status).toBe(1);
      expect(out).toContain(`✗ docs/a.md:${line}`);
      expect(out).toContain(`references '${target}'`);
    }, 120_000);
  }

  test("recognized fences and code spans mask fixture links", () => {
    const dir = makeFixture({ docs: { "docs/a.md": [
      "# A", "", "```markdown", "[bad](missing.md)", "[target]: missing.md", "```",
      "`[bad](missing.md)`", "`[bad](missing.md)", "still code`", "[target]", "", "~~~", "[bad](missing.md)", "~~~", "",
    ].join("\n") } });
    const { status, out } = runGate(dir);
    expect(status).toBe(0);
    expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
  }, 120_000);

  test("an unmatched backtick does not hide a later link", () => {
    const dir = makeFixture({ docs: { "docs/a.md": "# A\n\nAn unmatched ` marker.\n[broken](missing.md)\n\nLater `code`.\n" } });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ docs/a.md:4");
    expect(out).toContain("references 'missing.md'");
  }, 120_000);

  for (const ch of ["`", "~"]) {
    const fenceCases = [
      ["equal length", ch.repeat(3), true],
      ["longer", ch.repeat(4), true],
      ["shorter", ch.repeat(2), false],
      ["other marker", (ch === "`" ? "~" : "`").repeat(3), false],
      ["three leading spaces", `   ${ch.repeat(3)}`, true],
      ["four leading spaces", `    ${ch.repeat(3)}`, false],
      ["leading tab", `\t${ch.repeat(3)}`, false],
      ["trailing text", `${ch.repeat(3)} text`, false],
      ["trailing spaces and tabs", `${ch.repeat(3)} \t `, true],
      ["trailing carriage return", `${ch.repeat(3)}\r`, false],
    ] as const;
    for (const [form, closing, closes] of fenceCases) {
      test(`${ch} fence with ${form} ${closes ? "closes" : "stays open"}`, () => {
        const dir = makeFixture({ docs: { "docs/a.md": [
          "# A", "", ch.repeat(3), closing, "[bad](missing.md)", "",
        ].join("\n") } });
        const { status, out } = runGate(dir);
        expect(status).toBe(closes ? 1 : 0);
        if (closes) {
          expect(out).toContain("✗ docs/a.md:5");
          expect(out).toContain("references 'missing.md'");
        } else {
          expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
        }
      }, 120_000);
    }
  }

  const codeSpanCases = [
    ["equal-length run", "``", true],
    ["longer run", "```", false],
    ["shorter run", "`", false],
    ["backslash-preceded run", "\\``", false],
    ["two-backslash-preceded run", "\\\\``", false],
    ["equal run after a longer run", "``` then ``", true],
    ["equal run after a shorter run", "` then ``", true],
    ["equal run after an escaped run", "\\`` then ``", true],
    ["equal run on the next line", "\ncontinued ``", true],
  ] as const;
  for (const [form, closing, closes] of codeSpanCases) {
    test(`backtick scanner with ${form} ${closes ? "hides" : "exposes"} its link`, () => {
      const dir = makeFixture({ docs: {
        "docs/a.md": `# A\n\nOpening \`\` [bad](missing.md) ${closing}\n`,
      } });
      const { status, out } = runGate(dir);
      expect(status).toBe(closes ? 0 : 1);
      if (closes) {
        expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
      } else {
        expect(out).toContain("✗ docs/a.md:3");
        expect(out).toContain("references 'missing.md'");
      }
    }, 120_000);
  }

  test("same-line HTML comment exempts its mention but not the next line", () => {
    const dir = makeFixture({ docs: { "docs/a.md": [
      "# A", "", "See `host.md`. <!-- docs-freshness-allow: file belongs to the reader -->",
      "See [broken](missing.md).", "",
    ].join("\n") } });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).not.toContain("references 'host.md'");
    expect(out).toContain("✗ docs/a.md:4");
    expect(out).toContain("references 'missing.md'");
  }, 120_000);

  test("prose mention of the marker does not exempt a link", () => {
    const dir = makeFixture({ docs: { "docs/a.md": "# A\n\ndocs-freshness-allow: explanation [broken](missing.md).\n" } });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ docs/a.md:3");
    expect(out).toContain("references 'missing.md'");
  }, 120_000);

  test("a marker comment without an explanation does not exempt a link", () => {
    const dir = makeFixture({ docs: { "docs/a.md": "# A\n\n[broken](missing.md) <!-- docs-freshness-allow: -->\n" } });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ docs/a.md:3");
    expect(out).toContain("references 'missing.md'");
  }, 120_000);

  for (const [form, marker] of [
    ["empty comment followed by another comment", "<!-- docs-freshness-allow: --><!-- unrelated -->"],
    ["marker in inline code", "`<!-- docs-freshness-allow: example -->`"],
  ]) {
    test(`${form} does not exempt a link`, () => {
      const dir = makeFixture({ docs: { "docs/a.md": `# A\n\n[bad](missing.md) ${marker}\n` } });
      const { status, out } = runGate(dir);
      expect(status).toBe(1);
      expect(out).toContain("✗ docs/a.md:3");
      expect(out).toContain("references 'missing.md'");
    }, 120_000);
  }

  test("backticks in a link label do not create a file-name reference", () => {
    const dir = makeFixture({ docs: { "docs/a.md": "# A\n\nSee [`outside.md`](https://example.com/outside.md).\n" } });
    const { status, out } = runGate(dir);
    expect(status).toBe(0);
    expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
  }, 120_000);

  test("a link to a shipped .md passes", () => {
    const dir = makeFixture({
      docs: {
        "docs/a.md": "# A\n\nSee [b](b.md) for details.\n",
        "docs/b.md": "# B\n",
      },
    });
    const { status, out } = runGate(dir);
    expect(status).toBe(0);
    expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
    expect(out).not.toContain("references 'b.md'");
  }, 120_000);

  test("a link to an unshipped .md fails, naming the referencing file:line and target", () => {
    const dir = makeFixture({
      files: ["docs/"],
      docs: {
        "docs/a.md": "# A\n\nSee [the design](../notes/design.md) for details.\n",
        "notes/design.md": "# Design\n",
        "docs/b.md": "# B\n",
      },
    });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ docs/a.md:3");
    expect(out).toContain("../notes/design.md");
    expect(out).toContain("not in the package's npm pack file list");
  }, 120_000);

  test("a backtick-quoted missing .md fails", () => {
    const dir = makeFixture({
      docs: {
        "docs/a.md": "# A\n\nSee `missing-design.md` for the full design.\n",
      },
    });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ docs/a.md:3");
    expect(out).toContain("missing-design.md");
  }, 120_000);

  test("an http link and an anchor-only link are ignored", () => {
    const dir = makeFixture({
      docs: {
        "docs/a.md": [
          "# A",
          "",
          "[external](https://example.com/guide.md) and [top](#a) and [b](b.md#details).",
          "",
        ].join("\n"),
        "docs/b.md": "# B\n\n## Details\n",
      },
    });
    const { status, out } = runGate(dir);
    expect(status).toBe(0);
    expect(summaryLine(out)).toContain("✓ doc-link-pack-coverage");
    expect(out).not.toContain("example.com/guide.md");
  }, 120_000);

  test("an npm pack that fails fails the check", () => {
    const dir = makeFixture({
      prepack: "exit 1",
      docs: { "docs/a.md": "# A\n\nSee [b](b.md).\n", "docs/b.md": "# B\n" },
    });
    const { status, out } = runGate(dir);
    expect(status).toBe(1);
    expect(out).toContain("✗ package.json:1");
    expect(out).toContain("npm pack --dry-run --json");
    expect(summaryLine(out)).toContain("✗ doc-link-pack-coverage");
  }, 120_000);
});
