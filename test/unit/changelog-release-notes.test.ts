// GitHub release notes are a lede + links rendering, not a CHANGELOG dump
// (flair#1392).
//
// CHANGELOG.md stays the deep record. These tests pin the renderer against the
// committed v0.49.0 section (the release that measured 2,826 words verbatim)
// and against a committed Heads-up fixture. The Heads-up path is mutation-
// checked: remove the handling and the operator line disappears — a test that
// has never failed there proves nothing.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { extractChangelogSection } from "../../scripts/changelog-extract.mjs";
import {
  DEFAULT_REPO_URL,
  changelogTagUrl,
  extractBoldLede,
  extractHeadsUps,
  extractIssueRefs,
  ledeForEntry,
  parseChangelogEntries,
  renderReleaseNotes,
  renderReleaseNotesFromFile,
} from "../../scripts/changelog-release-notes.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");
const HEADS_UP_FIXTURE = join(REPO_ROOT, "test", "fixtures", "changelog-release-notes-heads-up.md");
const RENDERER = join(REPO_ROOT, "scripts", "changelog-release-notes.mjs");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release-publish.yml");

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function lineCount(s: string): number {
  return s.replace(/\n$/, "").split("\n").length;
}

describe("workflow wiring", () => {
  test("release-publish.yml renders through changelog-release-notes.mjs, not a raw extract", () => {
    const yml = readFileSync(WORKFLOW, "utf8");
    expect(yml).toContain("scripts/changelog-release-notes.mjs");
    expect(yml).not.toMatch(/changelog-extract\.mjs["']? \$VERSION/);
  });
});

describe("v0.49.0 — committed CHANGELOG section", () => {
  const raw = extractChangelogSection("0.49.0", CHANGELOG);
  const notes = renderReleaseNotesFromFile("0.49.0", CHANGELOG);
  const categories = parseChangelogEntries(raw);
  const entries = categories.flatMap((c) => c.entries);

  test("the fixture section is the dump this change exists to stop", () => {
    // Ground the budget against the measured verbatim page, not a guessed number.
    expect(wordCount(raw)).toBeGreaterThan(2000);
    expect(lineCount(raw)).toBeGreaterThan(200);
    expect(entries.length).toBeGreaterThan(10);
  });

  test("every entry keeps its lede", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const lede = ledeForEntry(entry);
      expect(lede.length).toBeGreaterThan(0);
      expect(notes).toContain(lede);
    }
  });

  test("output is under a sane word budget versus the verbatim dump", () => {
    const rawWords = wordCount(raw);
    const noteWords = wordCount(notes);
    expect(noteWords).toBeLessThan(900);
    expect(noteWords).toBeLessThan(rawWords * 0.4);
    expect(lineCount(notes)).toBeLessThan(80);
    expect(lineCount(notes)).toBeLessThan(lineCount(raw) * 0.3);
  });

  test("body detail is not dumped — including the credential line that is not a Heads-up", () => {
    // v0.49.0's operator-critical sentence lived in the body, not a Heads-up.
    // Summarising without the convention drops it. That is the bug the
    // convention exists to fix — and this assertion proves the renderer
    // does not quietly keep the rest of the body.
    expect(notes).not.toContain("reactivate a revoked row");
    expect(notes).not.toContain("584×");
    expect(notes).not.toContain("selectAbilitySlice");
  });

  test("footer links CHANGELOG.md at the tag", () => {
    expect(notes).toContain(changelogTagUrl("0.49.0"));
    expect(notes).toContain(`${DEFAULT_REPO_URL}/blob/v0.49.0/CHANGELOG.md`);
  });

  test("keeps category headings from the section", () => {
    expect(notes).toContain("### Added");
    expect(notes).toContain("### Fixed");
    expect(notes).toContain("### Security");
  });

  test("caps issue links at three and formats them as GitHub URLs", () => {
    const first = entries.find((e) => extractIssueRefs(e).length > 0);
    expect(first).toBeDefined();
    const refs = extractIssueRefs(first!);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.length).toBeLessThanOrEqual(3);
    expect(notes).toContain(`${DEFAULT_REPO_URL}/issues/${refs[0]}`);
  });
});

describe("Heads-up convention", () => {
  const section = extractChangelogSection("0.49.0", HEADS_UP_FIXTURE);
  const notes = renderReleaseNotes(section, { version: "0.49.0" });

  test("a Heads-up line is reproduced verbatim", () => {
    expect(notes).toContain("> **Heads-up:** before this fix, `revoked` was not terminal.");
    expect(extractHeadsUps(section)).toEqual([
      "> **Heads-up:** before this fix, `revoked` was not terminal.",
    ]);
  });

  test("the fixture body around the Heads-up is not dumped", () => {
    expect(notes).not.toContain("Provisioning used to insert a second active credential");
  });

  test("issue links past the first three are dropped", () => {
    expect(notes).toContain("/issues/1363");
    expect(notes).toContain("/issues/1357");
    expect(notes).toContain("/issues/9999");
    expect(notes).not.toContain("/issues/10000");
  });

  // THE powered check. The default renderer keeps the Heads-up (test above).
  // This test removes the handling from a copy of the source and asserts the
  // operator line vanishes. If extractHeadsUps were dead code, both paths
  // would still "pass" — this is the one that has to have gone red.
  test("powered: removing Heads-up handling drops the operator line", async () => {
    const src = readFileSync(RENDERER, "utf8");
    const mutated = src.replace(
      /export function extractHeadsUps\([\s\S]*?\n\}/,
      "export function extractHeadsUps(_entryText) { return []; }",
    );
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "flair-release-notes-mut-"));
    const copy = join(dir, "changelog-release-notes.mjs");
    // The mutated file still imports changelog-extract.mjs from ./
    writeFileSync(join(dir, "changelog-extract.mjs"), readFileSync(join(REPO_ROOT, "scripts", "changelog-extract.mjs")));
    writeFileSync(copy, mutated);
    const mod = await import(pathToFileURL(copy).href);
    const dropped = mod.renderReleaseNotes(section, { version: "0.49.0" });
    expect(dropped).not.toContain("**Heads-up:**");
    expect(dropped).not.toContain("revoked was not terminal");
    expect(dropped).toContain("Identity mapping now enforces one active IdP credential per subject");
  });

  test("injecting a no-op extractHeadsUpsFn also drops the line (same path)", () => {
    const dropped = renderReleaseNotes(section, {
      version: "0.49.0",
      extractHeadsUpsFn: () => [],
    });
    expect(dropped).not.toContain("**Heads-up:**");
    expect(notes).toContain("**Heads-up:**");
  });
});

describe("issue refs — in-repo only (Bugbot / flair#1392)", () => {
  test("owner/repo#N is not rewritten as a Flair issue URL; bare #N still is", () => {
    const entry = "- **A thing.** Mentions HarperFast/harper#2316 and also #1392.";
    expect(extractIssueRefs(entry)).toEqual(["1392"]);

    const notes = renderReleaseNotes(`### Fixed\n\n${entry}\n`, { version: "0.49.0" });
    expect(notes).toContain(`${DEFAULT_REPO_URL}/issues/1392`);
    expect(notes).not.toContain(`${DEFAULT_REPO_URL}/issues/2316`);
    expect(notes).not.toMatch(/tpsdev-ai\/flair\/issues\/2316/);
  });

  test("flair#N and tpsdev-ai/flair#N stay in-repo; other owner/repo#N does not", () => {
    expect(extractIssueRefs("- **x** (flair#42)")).toEqual(["42"]);
    expect(extractIssueRefs("- **x** tpsdev-ai/flair#42")).toEqual(["42"]);
    expect(extractIssueRefs("- **x** other/repo#42")).toEqual([]);
    expect(extractIssueRefs("- **x** HarperFast/harper#42 and flair#7")).toEqual(["7"]);
  });

  test("a cross-repo ref does not consume a slot in the ≤3 cap", () => {
    const entry = "- **x** HarperFast/harper#1 #10 #11 #12 #13";
    expect(extractIssueRefs(entry)).toEqual(["10", "11", "12"]);
  });
});

describe("parse / lede helpers", () => {
  test("extractBoldLede spans wrapped bold runs", () => {
    const entry = "- **A wrapped\n  lede here** (flair#1). Body that is not the lede.";
    expect(extractBoldLede(entry)).toBe("A wrapped lede here");
  });

  test("ledeForEntry falls back when there is no bold run", () => {
    const entry = "- n8n-nodes-flair's credential Base URL default now matches Flair's stock port (flair#1352): more body.";
    expect(ledeForEntry(entry)).toBe(
      "n8n-nodes-flair's credential Base URL default now matches Flair's stock port",
    );
  });
});

describe("CLI", () => {
  test("changelog-extract.mjs still prints the raw section (the record reader)", () => {
    const extract = join(REPO_ROOT, "scripts", "changelog-extract.mjs");
    const r = spawnSync(process.execPath, [extract, "0.49.0", CHANGELOG], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reactivate a revoked row");
    expect(wordCount(r.stdout)).toBeGreaterThan(2000);
  });

  test("writes rendered notes for a version that exists", () => {
    const r = spawnSync(process.execPath, [RENDERER, "0.49.0", CHANGELOG], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### Added");
    expect(r.stdout).toContain("CHANGELOG.md");
    expect(r.stdout).not.toContain("reactivate a revoked row");
  });

  test("fails loudly when the section is missing", () => {
    const r = spawnSync(process.execPath, [RENDERER, "0.0.0", CHANGELOG], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/no '## \[0\.0\.0\]' section/);
  });
});
