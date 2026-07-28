# Changelog fragments

One file per change. Two pull requests never edit the same file, so the
`[Unreleased]` section of `CHANGELOG.md` stopped being a guaranteed merge
conflict — and nobody loses a review round to resolving one (flair#835).

## Adding an entry

Create `<category>-<slug>.md` in this directory:

```
.changelog/unreleased/fixed-migration-boot-data-dir.md
```

- **category** — the text before the first hyphen. One of `added`, `changed`,
  `deprecated`, `removed`, `fixed`, `security` ([Keep a
  Changelog](https://keepachangelog.com/en/1.1.0/)). It determines which
  `### Heading` the entry lands under.
- **slug** — everything after it. Make it descriptive; you own uniqueness. A
  PR number works but is not expected — the branch is usually pushed before the
  PR number exists.

The file contains the entry **exactly as it should appear** under its heading,
including the leading `- ` and a 2-space indent on continuation lines:

```markdown
- **The thing that changed, in bold.** What it means for someone running Flair,
  and what they have to do about it (usually nothing).

  A second paragraph, indented two spaces so it stays inside the list item.
```

Assembly is a pure join — no reflow, no re-indent, no rewrapping — so tables and
nested code blocks survive verbatim. The flip side is that a fragment which is
not already a well-formed list item is a hard error rather than something the
tooling quietly fixes up: silent normalisation is how content goes missing.

## Checking your work

```bash
node scripts/changelog-fragments.mjs render   # preview the assembled section
node scripts/changelog-fragments.mjs list     # what is staged, by category
node scripts/changelog-fragments.mjs check    # what CI runs
```

The docs-freshness gate fails a PR when feat/fix commits have landed since the
last release tag and this directory is empty, and fails on a malformed fragment
rather than skipping it.

## At release time

`scripts/release.sh <version>` assembles every fragment into a
`## [<version>] - <date>` section in `CHANGELOG.md`, in Keep a Changelog category
order and by filename within each category, then deletes the fragments. Entry
order within a category carries no meaning; stability does, and filename sort is
stable across machines and filesystems.

Do not add entries directly to `## [Unreleased]` in `CHANGELOG.md`. The release
step replaces that section's body, so a hand-written entry there is lost — which
is why both the gate and the release step refuse when they find one.
