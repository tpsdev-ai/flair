#!/usr/bin/env node
// Changelog fragment files (flair#835).
//
// PROBLEM. Every PR was required to add its entry to the single `[Unreleased]`
// block at the top of CHANGELOG.md. That made those lines a guaranteed conflict
// point: with N concurrent PRs, the last to merge conflicts N-1 times. The cost
// is not the resolution — it is that a merge/rebase to resolve DISMISSES the
// existing approvals, so every conflict buys a full second review round for zero
// content change. A generic resolver also silently produced an EMPTY section
// once, because the conflict began below a `### Fixed` header and the surviving
// entries had no header to attach to.
//
// FIX. One file per change under `.changelog/unreleased/`. Two PRs never touch
// the same file, so the conflict cannot occur. `scripts/release.sh` assembles
// the fragments into a `## [X.Y.Z]` section and deletes them as part of the cut.
//
// FILE NAMING: `.changelog/unreleased/<category>-<slug>.md`
//   category  one of added|changed|deprecated|removed|fixed|security
//             (Keep a Changelog), taken from the text BEFORE the first hyphen
//   slug      anything else; make it descriptive, uniqueness is on you (a PR
//             number is a fine slug, but is not required — the branch is pushed
//             before the PR number exists)
//
// FILE CONTENT: the entry exactly as it should appear under its `### Category`
// heading, INCLUDING the leading `- ` and the 2-space indent on continuation
// lines. Assembly is then a pure join: no reflow, no re-indent, no re-wrapping.
// That is deliberate. The failure this design exists to prevent is silent
// content loss, and every normalisation step is somewhere content can be
// silently altered. A fragment that does not already look like a list item is a
// hard error, not something to be helpfully fixed up.
//
// USAGE
//   node scripts/changelog-fragments.mjs render      print the assembled section
//   node scripts/changelog-fragments.mjs list        one line per fragment
//   node scripts/changelog-fragments.mjs check       validate; non-zero on error
//   node scripts/changelog-fragments.mjs promote <version> [--date=YYYY-MM-DD]
//                                                    write the section into
//                                                    CHANGELOG.md and delete the
//                                                    fragments

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const FRAGMENT_DIR_REL = join(".changelog", "unreleased");
export const FRAGMENT_DIR = join(ROOT, FRAGMENT_DIR_REL);
export const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

// Keep a Changelog order. This array IS the ordering — categories are emitted in
// this sequence regardless of what the filesystem hands back.
export const CATEGORIES = ["added", "changed", "deprecated", "removed", "fixed", "security"];
const HEADING = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};

// The body `## [Unreleased]` carries once entries live in fragments. Kept as a
// constant so the docs-freshness gate and the release script agree on it.
export const UNRELEASED_NOTE = [
  "Entries for the next release live as **fragment files** under [`.changelog/unreleased/`](.changelog/unreleased/) —",
  "one file per change, so two pull requests never edit the same lines and never conflict here.",
  "",
  "Add `.changelog/unreleased/<category>-<slug>.md` containing your entry exactly as it should read",
  "under its `### Category` heading, leading `- ` included. Categories: `added`, `changed`,",
  "`deprecated`, `removed`, `fixed`, `security`.",
  "",
  "```bash",
  "node scripts/changelog-fragments.mjs render   # preview the assembled section",
  "node scripts/changelog-fragments.mjs check    # what CI checks",
  "```",
  "",
  "`scripts/release.sh` assembles them into a `## [X.Y.Z]` section and deletes them as part of the",
  "version cut. **Do not add entries to this section by hand** — the release step replaces its body,",
  "so a hand-written entry here is lost.",
].join("\n");

// ─── Fragment reading ─────────────────────────────────────────────────────────

export class FragmentError extends Error {}

// `<category>-<slug>.md` → { category, slug }. Throws with the offending name and
// the remedy — a fragment that cannot be placed must never be silently skipped.
export function parseFragmentName(filename) {
  if (!filename.endsWith(".md")) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: not a .md file. Changelog fragments must be named ` +
        `<category>-<slug>.md (categories: ${CATEGORIES.join(", ")}).`,
    );
  }
  const stem = filename.slice(0, -".md".length);
  const dash = stem.indexOf("-");
  const category = (dash === -1 ? stem : stem.slice(0, dash)).toLowerCase();
  if (!CATEGORIES.includes(category)) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: '${dash === -1 ? stem : stem.slice(0, dash)}' is not a changelog ` +
        `category. Rename it <category>-<slug>.md with category one of: ${CATEGORIES.join(", ")}.`,
    );
  }
  const slug = dash === -1 ? "" : stem.slice(dash + 1);
  if (slug.length === 0) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: missing the '-<slug>' part. Name it ${category}-<something-descriptive>.md.`,
    );
  }
  return { category, slug };
}

// The body must already be a well-formed top-level list item, because assembly
// does not rewrite it. Anything else is an error the author fixes, not something
// this script guesses at.
export function validateFragmentBody(relPath, body) {
  if (body.trim().length === 0) {
    throw new FragmentError(`${relPath}: fragment is empty. Write the changelog entry into it, or delete the file.`);
  }
  if (!body.startsWith("- ")) {
    throw new FragmentError(
      `${relPath}: fragment must start with '- ' (the markdown list marker) so it can be placed under its ` +
        `### heading verbatim. Indent continuation lines by 2 spaces.`,
    );
  }
}

// Read every fragment in `dir`. Dotfiles are ignored (.DS_Store, .gitkeep);
// README.md documents the convention and is not a fragment. EVERYTHING else is
// parsed, and a file that will not parse throws — a fragment directory that
// quietly skips files is the silent-drop bug this whole change exists to remove.
export function readFragments(dir = FRAGMENT_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    if (name === "README.md") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      throw new FragmentError(
        `${FRAGMENT_DIR_REL}/${name}: unexpected directory. Fragments are flat files named <category>-<slug>.md.`,
      );
    }
    const { category, slug } = parseFragmentName(name);
    const body = readFileSync(full, "utf8").replace(/\s+$/, "");
    validateFragmentBody(`${FRAGMENT_DIR_REL}/${name}`, body);
    out.push({ name, path: full, category, slug, body });
  }
  return out;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

// Deterministic by construction: categories in CATEGORIES order, fragments within
// a category by codepoint-ordered filename. Never readdir order, never
// localeCompare (locale-dependent). Same fragments in ⇒ same bytes out.
export function assemble(fragments) {
  const blocks = [];
  for (const category of CATEGORIES) {
    const inCategory = fragments
      .filter((f) => f.category === category)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (inCategory.length === 0) continue;
    blocks.push(`### ${HEADING[category]}\n\n${inCategory.map((f) => f.body).join("\n\n")}`);
  }
  return blocks.join("\n\n");
}

// Count of top-level entries in an assembled section. Used by the gate and the
// release step to report "N entries" against the fragment count — if those two
// numbers ever disagree, something was dropped.
export function countEntries(section) {
  return section.split("\n").filter((l) => l.startsWith("- ")).length;
}

// ─── CHANGELOG.md surgery ─────────────────────────────────────────────────────

export function locateUnreleased(lines) {
  const start = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end).join("\n") };
}

// Hand-written entries under `## [Unreleased]` are a data-loss trap now that
// promote REPLACES that body: they would be silently discarded at the version
// cut. Detect them by their list marker (prose edits to the note are fine).
export function strayUnreleasedEntries(body) {
  return body.split("\n").filter((l) => l.startsWith("- "));
}

export function promote(version, { date, changelogPath = CHANGELOG_PATH, dir = FRAGMENT_DIR } = {}) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/.test(version ?? "")) {
    throw new FragmentError(`promote: invalid version '${version}'. Expected semver, e.g. 0.31.0.`);
  }
  const fragments = readFragments(dir);
  if (fragments.length === 0) {
    throw new FragmentError(
      `promote: no fragments in ${FRAGMENT_DIR_REL}/ — refusing to cut v${version} with an empty changelog section. ` +
        `Add the entries for this release before running the release script.`,
    );
  }
  const text = readFileSync(changelogPath, "utf8");
  const lines = text.split("\n");
  const loc = locateUnreleased(lines);
  if (!loc) throw new FragmentError(`promote: no '## [Unreleased]' section in ${changelogPath}.`);

  const stray = strayUnreleasedEntries(loc.body);
  if (stray.length > 0) {
    throw new FragmentError(
      `promote: '## [Unreleased]' contains ${stray.length} hand-written entr${stray.length === 1 ? "y" : "ies"} ` +
        `that this step would overwrite. Move ${stray.length === 1 ? "it" : "them"} into ` +
        `${FRAGMENT_DIR_REL}/<category>-<slug>.md first. First one: ${stray[0].slice(0, 80)}`,
    );
  }

  const section = assemble(fragments);
  const entries = countEntries(section);
  if (entries !== fragments.length) {
    // Structurally impossible unless a fragment body carries a second top-level
    // list item. Loud, because the alternative is an entry count nobody checks.
    throw new FragmentError(
      `promote: assembled ${entries} entries from ${fragments.length} fragments. A fragment holds more than ` +
        `one top-level '- ' item; split it into one file per entry.`,
    );
  }

  const day = date ?? new Date().toISOString().slice(0, 10);
  const replacement = [
    "",
    UNRELEASED_NOTE,
    "",
    `## [${version}] - ${day}`,
    "",
    section,
    "",
  ];
  const next = [...lines.slice(0, loc.start + 1), ...replacement, ...lines.slice(loc.end)];
  writeFileSync(changelogPath, next.join("\n"));
  for (const f of fragments) unlinkSync(f.path);
  return { version, date: day, entries, removed: fragments.map((f) => f.name) };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2] ?? "render";
  try {
    if (cmd === "render") {
      const section = assemble(readFragments());
      if (section.length > 0) process.stdout.write(section + "\n");
    } else if (cmd === "list") {
      const fragments = readFragments();
      for (const c of CATEGORIES) {
        for (const f of fragments.filter((x) => x.category === c).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          process.stdout.write(`${HEADING[c].padEnd(10)} ${f.name}\n`);
        }
      }
      process.stdout.write(`\n${fragments.length} fragment(s) in ${FRAGMENT_DIR_REL}/\n`);
    } else if (cmd === "check") {
      const fragments = readFragments();
      const section = assemble(fragments);
      const entries = countEntries(section);
      if (entries !== fragments.length) {
        throw new FragmentError(
          `assembled ${entries} entries from ${fragments.length} fragments — a fragment holds more than one ` +
            `top-level '- ' item. Split it into one file per entry.`,
        );
      }
      const loc = locateUnreleased(readFileSync(CHANGELOG_PATH, "utf8").split("\n"));
      const stray = loc ? strayUnreleasedEntries(loc.body) : [];
      if (stray.length > 0) {
        throw new FragmentError(
          `CHANGELOG.md '## [Unreleased]' has ${stray.length} hand-written entr${stray.length === 1 ? "y" : "ies"}; ` +
            `move ${stray.length === 1 ? "it" : "them"} into ${FRAGMENT_DIR_REL}/.`,
        );
      }
      process.stdout.write(`✓ ${fragments.length} fragment(s), ${entries} entr(ies), no stray [Unreleased] entries.\n`);
    } else if (cmd === "promote") {
      const version = process.argv[3];
      const dateArg = process.argv.find((a) => a.startsWith("--date="));
      const res = promote(version, { date: dateArg ? dateArg.slice("--date=".length) : undefined });
      process.stdout.write(
        `✓ promoted ${res.entries} entr(ies) into '## [${res.version}] - ${res.date}'; removed ${res.removed.length} fragment(s).\n`,
      );
    } else {
      process.stderr.write(`changelog-fragments: unknown command '${cmd}'. Try: render | list | check | promote <version>\n`);
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`changelog-fragments: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
