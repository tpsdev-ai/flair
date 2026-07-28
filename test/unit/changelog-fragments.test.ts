// Changelog fragment assembly (flair#835).
//
// The load-bearing test here is "N fragments in ⇒ N entries out". A generic
// conflict resolver once produced an EMPTY [Unreleased] section from a hand
// resolution, because the conflict began below a `### Fixed` header and the
// surviving entries had no header to attach to. It was caught only because
// somebody printed the result. Assembly is now the single place that can lose an
// entry, so it is the place that gets the count assertion — and the count alone
// is not enough (it would pass if one entry were duplicated while another was
// dropped), so every fragment also carries a unique marker asserted present
// exactly once.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CATEGORIES,
  assemble,
  countEntries,
  locateUnreleased,
  promote,
  readFragments,
  strayUnreleasedEntries,
  UNRELEASED_NOTE,
} from "../../scripts/changelog-fragments.mjs";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "flair-changelog-frag-"));
}

function write(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

describe("readFragments", () => {
  test("reads category and slug from the filename", () => {
    const dir = tmp();
    write(dir, "fixed-migration-boot-data-dir.md", "- **A fix.** Details.\n");
    const [f] = readFragments(dir);
    expect(f.category).toBe("fixed");
    expect(f.slug).toBe("migration-boot-data-dir");
    expect(f.body).toBe("- **A fix.** Details.");
  });

  test("accepts every Keep a Changelog category", () => {
    const dir = tmp();
    for (const c of CATEGORIES) write(dir, `${c}-thing.md`, `- ${c} entry\n`);
    expect(readFragments(dir).length).toBe(CATEGORIES.length);
  });

  test("ignores dotfiles and README.md, never a real fragment", () => {
    const dir = tmp();
    write(dir, "README.md", "# how to write a fragment\n");
    write(dir, ".DS_Store", "junk");
    write(dir, ".gitkeep", "");
    write(dir, "added-real.md", "- **Real.** Kept.\n");
    const frags = readFragments(dir);
    expect(frags.length).toBe(1);
    expect(frags[0].name).toBe("added-real.md");
  });

  test("returns [] for a directory that does not exist", () => {
    expect(readFragments(join(tmp(), "nope"))).toEqual([]);
  });

  // Every one of these is a file an author plainly meant as a changelog entry.
  // Skipping it would lose it silently, which is the whole bug — so they throw.
  test("throws on a filename whose prefix is not a category", () => {
    const dir = tmp();
    write(dir, "misc-typo.md", "- **Something.** Body.\n");
    expect(() => readFragments(dir)).toThrow(/not a changelog category/);
  });

  test("throws on a filename with no slug", () => {
    const dir = tmp();
    write(dir, "fixed.md", "- **Something.** Body.\n");
    expect(() => readFragments(dir)).toThrow(/missing the '-<slug>' part/);
  });

  test("throws on a non-markdown file", () => {
    const dir = tmp();
    write(dir, "fixed-thing.txt", "- **Something.** Body.\n");
    expect(() => readFragments(dir)).toThrow(/not a \.md file/);
  });

  test("throws on a nested directory", () => {
    const dir = tmp();
    mkdirSync(join(dir, "fixed-nested"));
    expect(() => readFragments(dir)).toThrow(/unexpected directory/);
  });

  test("throws on an empty fragment", () => {
    const dir = tmp();
    write(dir, "fixed-empty.md", "\n\n  \n");
    expect(() => readFragments(dir)).toThrow(/fragment is empty/);
  });

  test("throws on a fragment that is not a top-level list item", () => {
    const dir = tmp();
    write(dir, "fixed-no-marker.md", "Something happened but I forgot the dash.\n");
    expect(() => readFragments(dir)).toThrow(/must start with '- '/);
  });
});

describe("assemble", () => {
  // THE test. Given N fragments, the output contains N entries — and each one is
  // the fragment that was put in, exactly once.
  test.each([1, 2, 3, 5, 8, 13, 21])("N=%i fragments assemble to N entries, none dropped", (n) => {
    const dir = tmp();
    const markers: string[] = [];
    for (let i = 0; i < n; i++) {
      const category = CATEGORIES[i % CATEGORIES.length];
      const marker = `FRAGMENT-MARKER-${i}-${category}`;
      write(dir, `${category}-entry-${String(i).padStart(3, "0")}.md`, `- **Entry ${i}.** ${marker}\n`);
      markers.push(marker);
    }

    const fragments = readFragments(dir);
    expect(fragments.length).toBe(n);

    const section = assemble(fragments);
    expect(countEntries(section)).toBe(n);

    // The count on its own would survive "one duplicated, one dropped". These
    // assertions do not.
    for (const marker of markers) {
      expect(section.split(marker).length - 1).toBe(1);
    }
  });

  test("output is independent of the order fragments are read in", () => {
    const dir = tmp();
    for (let i = 0; i < 12; i++) {
      const category = CATEGORIES[i % CATEGORIES.length];
      write(dir, `${category}-entry-${String(i).padStart(3, "0")}.md`, `- Entry ${i}\n`);
    }
    const fragments = readFragments(dir);
    const forwards = assemble(fragments);
    const backwards = assemble([...fragments].reverse());
    const rotated = assemble([...fragments.slice(5), ...fragments.slice(0, 5)]);
    expect(backwards).toBe(forwards);
    expect(rotated).toBe(forwards);
  });

  test("categories are emitted in Keep a Changelog order, whatever order they arrive in", () => {
    const dir = tmp();
    for (const c of [...CATEGORIES].reverse()) write(dir, `${c}-thing.md`, `- ${c} entry\n`);
    const headings = assemble(readFragments(dir))
      .split("\n")
      .filter((l) => l.startsWith("### "));
    expect(headings).toEqual(["### Added", "### Changed", "### Deprecated", "### Removed", "### Fixed", "### Security"]);
  });

  test("within a category, fragments sort by filename (stable across machines)", () => {
    const dir = tmp();
    for (const slug of ["zulu", "alpha", "mike"]) write(dir, `fixed-${slug}.md`, `- entry ${slug}\n`);
    const entries = assemble(readFragments(dir))
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(entries).toEqual(["- entry alpha", "- entry mike", "- entry zulu"]);
  });

  test("bodies are placed verbatim — tables, code fences and paragraphs survive", () => {
    const dir = tmp();
    const body = [
      "- **A measured change.** Numbers below:",
      "",
      "  | | p@3 | latency |",
      "  |---|---|---|",
      "  | before | 0.976 | 147 ms |",
      "",
      "  ```bash",
      "  flair status --port 19926",
      "  ```",
      "",
      "  A closing paragraph with a - dash and **bold** text.",
    ].join("\n");
    write(dir, "changed-measured.md", body + "\n");
    const section = assemble(readFragments(dir));
    expect(section).toBe(`### Changed\n\n${body}`);
    expect(countEntries(section)).toBe(1);
  });

  test("empty fragment set assembles to an empty section, not a stray heading", () => {
    expect(assemble([])).toBe("");
  });
});

describe("countEntries", () => {
  test("counts only top-level list markers", () => {
    const section = ["### Fixed", "", "- one", "  - nested, not an entry", "  continuation - with a dash", "", "- two"].join("\n");
    expect(countEntries(section)).toBe(2);
  });
});

describe("strayUnreleasedEntries", () => {
  test("finds hand-written entries the release step would overwrite", () => {
    expect(strayUnreleasedEntries(UNRELEASED_NOTE).length).toBe(0);
    expect(strayUnreleasedEntries(`${UNRELEASED_NOTE}\n\n- **Written the old way.** Lost at cut time.`).length).toBe(1);
  });
});

describe("promote", () => {
  function scaffold(): { dir: string; changelog: string } {
    const root = tmp();
    const dir = join(root, "unreleased");
    mkdirSync(dir);
    const changelog = join(root, "CHANGELOG.md");
    writeFileSync(
      changelog,
      ["# Changelog", "", "## [Unreleased]", "", UNRELEASED_NOTE, "", "## [0.30.0] - 2026-07-27", "", "### Added", "", "- **Shipped.** History.", ""].join("\n"),
    );
    return { dir, changelog };
  }

  test("inserts the assembled section and deletes every fragment", () => {
    const { dir, changelog } = scaffold();
    write(dir, "added-one.md", "- **One.** MARKER-ONE\n");
    write(dir, "fixed-two.md", "- **Two.** MARKER-TWO\n");

    const res = promote("0.31.0", { date: "2026-07-28", changelogPath: changelog, dir });
    expect(res.entries).toBe(2);
    expect(res.removed.sort()).toEqual(["added-one.md", "fixed-two.md"]);
    expect(readdirSync(dir)).toEqual([]);

    const text = readFileSync(changelog, "utf8");
    expect(text).toContain("## [0.31.0] - 2026-07-28");
    expect(text).toContain("MARKER-ONE");
    expect(text).toContain("MARKER-TWO");
    // Every fragment became exactly one entry in the new section.
    const lines = text.split("\n");
    const from = lines.findIndex((l) => l.startsWith("## [0.31.0]"));
    const to = lines.findIndex((l, i) => i > from && l.startsWith("## ["));
    expect(countEntries(lines.slice(from, to).join("\n"))).toBe(2);
  });

  test("released history is untouched and [Unreleased] keeps its note", () => {
    const { dir, changelog } = scaffold();
    const before = readFileSync(changelog, "utf8");
    write(dir, "added-one.md", "- **One.** Body.\n");

    promote("0.31.0", { date: "2026-07-28", changelogPath: changelog, dir });
    const after = readFileSync(changelog, "utf8");

    // Prefix (title + [Unreleased] + its note) is byte-identical...
    const cut = (t: string) => t.slice(0, t.indexOf("## [0.30.0]"));
    expect(cut(after).startsWith(cut(before).slice(0, cut(before).indexOf("## [0.30.0]")))).toBe(true);
    expect(after).toContain(UNRELEASED_NOTE);
    // ...and everything from the previous release onward is byte-identical.
    expect(after.slice(after.indexOf("## [0.30.0]"))).toBe(before.slice(before.indexOf("## [0.30.0]")));
    // The new section sits between them, not inside the old one.
    expect(after.indexOf("## [0.31.0]")).toBeGreaterThan(after.indexOf("## [Unreleased]"));
    expect(after.indexOf("## [0.31.0]")).toBeLessThan(after.indexOf("## [0.30.0]"));
  });

  test("refuses to cut a release with no fragments", () => {
    const { dir, changelog } = scaffold();
    expect(() => promote("0.31.0", { changelogPath: changelog, dir })).toThrow(/no fragments/);
    // The CHANGELOG is left alone on refusal.
    expect(readFileSync(changelog, "utf8")).toContain("## [Unreleased]");
    expect(readFileSync(changelog, "utf8")).not.toContain("## [0.31.0]");
  });

  test("refuses when a hand-written entry sits in [Unreleased] that it would overwrite", () => {
    const { dir, changelog } = scaffold();
    write(dir, "added-one.md", "- **One.** Body.\n");
    const text = readFileSync(changelog, "utf8").replace(
      "## [0.30.0]",
      "- **Hand-written, would be lost.** Body.\n\n## [0.30.0]",
    );
    writeFileSync(changelog, text);
    expect(() => promote("0.31.0", { changelogPath: changelog, dir })).toThrow(/hand-written entr/);
    // Refusal is non-destructive: the fragment is still there.
    expect(readdirSync(dir)).toEqual(["added-one.md"]);
  });

  test("refuses a fragment carrying more than one top-level entry", () => {
    const { dir, changelog } = scaffold();
    write(dir, "fixed-two-in-one.md", "- **First.** Body.\n\n- **Second.** Body.\n");
    expect(() => promote("0.31.0", { changelogPath: changelog, dir })).toThrow(/more than\s+one top-level/);
    expect(existsSync(join(dir, "fixed-two-in-one.md"))).toBe(true);
  });

  test("rejects a non-semver version", () => {
    const { dir, changelog } = scaffold();
    write(dir, "added-one.md", "- **One.** Body.\n");
    for (const bad of ["", "v0.31.0", "0.31", "0.31.0; rm -rf /"]) {
      expect(() => promote(bad, { changelogPath: changelog, dir })).toThrow(/invalid version/);
    }
  });
});

describe("locateUnreleased", () => {
  test("bounds the section at the next version header", () => {
    const lines = ["# Changelog", "", "## [Unreleased]", "", "note", "", "## [0.30.0] - 2026-07-27", "", "- old"];
    const loc = locateUnreleased(lines);
    expect(loc?.start).toBe(2);
    expect(loc?.end).toBe(6);
    expect(loc?.body).toBe("\nnote\n");
  });

  test("returns null when there is no [Unreleased] section", () => {
    expect(locateUnreleased(["# Changelog", "", "## [0.30.0]"])).toBeNull();
  });
});
