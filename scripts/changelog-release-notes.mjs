#!/usr/bin/env node
// Render GitHub release notes from a CHANGELOG section (flair#1392).
//
// TWO AUDIENCES, ONE RECORD. CHANGELOG.md is the engineering record — depth
// there is a feature and this script does not shrink it. The GitHub release
// page answers "what changed, should I upgrade, what must I do". Dumping the
// section verbatim made that page unreadable (2,826 words for v0.49.0).
//
// Per entry this keeps:
//   - the bold lede (or a first-sentence fallback when an old entry has none)
//   - up to three issue links, in order of appearance
//   - any `> **Heads-up:**` operator lines, verbatim
// and nothing else. A footer links the full CHANGELOG.md at the tag.
//
// Usage: node scripts/changelog-release-notes.mjs <version> [changelog-path]
//   <version>      bare semver, e.g. 0.49.0 (no leading "v")
//   changelog-path defaults to ./CHANGELOG.md
//
// Prints the rendered notes to stdout. Exits non-zero if the section is
// missing or empty — same fail-loud contract as changelog-extract.mjs.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractChangelogSection, ExtractError, SEMVER_RE } from "./changelog-extract.mjs";

export const DEFAULT_REPO_URL = "https://github.com/tpsdev-ai/flair";
export const MAX_ISSUE_LINKS = 3;

// Bare `#N` and in-repo aliases (`flair#N`, `tpsdev-ai/flair#N`) become Flair
// issue links. `owner/repo#N` for any other repo (HarperFast/harper#2316, …)
// must not — those numbers are not Flair issues (flair#1392 / Bugbot).
const IN_REPO_CROSS_REFS = new Set(["tpsdev-ai/flair"]);
const ISSUE_REF_RE = /(?:([\w.-]+\/[\w.-]+)|flair)?#(\d+)/g;
const ISSUE_CITE_RE = / \((?:flair)?#\d+/;
const HEADS_UP_RE = /^\s*>\s*\*\*Heads-up:\*\*/i;

export function collapseWs(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/** First `**...**` after the list marker, spanning newlines. Null if none. */
export function extractBoldLede(entryText) {
  const m = String(entryText).match(/^- \*\*([\s\S]*?)\*\*/);
  if (!m) return null;
  return collapseWs(m[1]);
}

function firstSentence(text) {
  let inTick = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") inTick = !inTick;
    if (!inTick && (c === "." || c === "!" || c === "?") && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return text.slice(0, i + 1).trim();
    }
  }
  return text.trim();
}

/**
 * Lede for an entry that never grew a bold run (historical CHANGELOG). Cut at
 * the first issue citation or the first sentence — do not invent a summary
 * and do not dump the rest of the body.
 */
export function fallbackLede(entryText) {
  const text = collapseWs(String(entryText).replace(/^- /, ""));
  const cite = text.search(ISSUE_CITE_RE);
  const bounded = cite > 0 ? text.slice(0, cite) : text;
  return firstSentence(bounded);
}

export function ledeForEntry(entryText) {
  return extractBoldLede(entryText) ?? fallbackLede(entryText);
}

/** Unique issue numbers in appearance order, capped at MAX_ISSUE_LINKS. */
export function extractIssueRefs(entryText, limit = MAX_ISSUE_LINKS) {
  const seen = new Set();
  const out = [];
  ISSUE_REF_RE.lastIndex = 0;
  for (const m of String(entryText).matchAll(ISSUE_REF_RE)) {
    const crossRepo = m[1];
    if (crossRepo && !IN_REPO_CROSS_REFS.has(crossRepo.toLowerCase())) continue;
    const n = m[2];
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Verbatim `> **Heads-up:**` blockquotes from an entry (continuation `>`
 * lines included). This is the load-bearing path: operator-critical detail
 * lives in the body, and summarising without this drops exactly the
 * sentences that matter most.
 */
export function extractHeadsUps(entryText) {
  const lines = String(entryText).split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HEADS_UP_RE.test(lines[i])) continue;
    const block = [lines[i].replace(/^\s+/, "")];
    i++;
    while (i < lines.length && /^\s*>/.test(lines[i])) {
      block.push(lines[i].replace(/^\s+/, ""));
      i++;
    }
    i--;
    blocks.push(block.join("\n"));
  }
  return blocks;
}

/**
 * Split a CHANGELOG section body into `{ heading, entries[] }`.
 * An entry is a top-level `- ` item plus its continuation lines.
 */
export function parseChangelogEntries(section) {
  const lines = String(section).split("\n");
  const categories = [];
  let current = null;
  let entryLines = null;

  const flushEntry = () => {
    if (!entryLines || !current) {
      entryLines = null;
      return;
    }
    const text = entryLines.join("\n").replace(/\s+$/, "");
    if (text.length > 0) current.entries.push(text);
    entryLines = null;
  };
  const flushCat = () => {
    flushEntry();
    if (current) categories.push(current);
    current = null;
  };

  for (const line of lines) {
    const h = line.match(/^###\s+(.+)$/);
    if (h) {
      flushCat();
      current = { heading: h[1].trim(), entries: [] };
      continue;
    }
    if (line.startsWith("- ") && current) {
      flushEntry();
      entryLines = [line];
      continue;
    }
    if (entryLines) entryLines.push(line);
  }
  flushCat();
  return categories;
}

export function issueLink(n, repoUrl = DEFAULT_REPO_URL) {
  return `[#${n}](${repoUrl}/issues/${n})`;
}

export function changelogTagUrl(version, repoUrl = DEFAULT_REPO_URL) {
  return `${repoUrl}/blob/v${version}/CHANGELOG.md`;
}

function renderEntry(entryText, { repoUrl, extractHeadsUpsFn = extractHeadsUps } = {}) {
  const lede = ledeForEntry(entryText);
  const refs = extractIssueRefs(entryText);
  const links = refs.map((n) => issueLink(n, repoUrl)).join(", ");
  const head = links ? `- **${lede.replace(/^\*\*|\*\*$/g, "")}** (${links})` : `- **${lede}**`;
  // Re-wrap in bold so fallback ledes match the "bold lede" surface. The
  // source lede may already be bold; extractBoldLede stripped the markers.
  const headsUps = extractHeadsUpsFn(entryText);
  if (headsUps.length === 0) return head;
  return [head, "", ...headsUps.map((b) => b.split("\n").map((l) => `  ${l}`).join("\n"))].join("\n");
}

/**
 * Render release notes from a section body (no `## [version]` header).
 *
 * `extractHeadsUpsFn` is injectable so a powered check can remove Heads-up
 * handling and prove the operator line disappears — a test that has never
 * failed there proves nothing.
 */
export function renderReleaseNotes(section, {
  version,
  repoUrl = DEFAULT_REPO_URL,
  extractHeadsUpsFn = extractHeadsUps,
} = {}) {
  if (!version || !SEMVER_RE.test(version)) {
    throw new ExtractError(`changelog-release-notes: invalid version '${version}'`, 2);
  }
  const categories = parseChangelogEntries(section);
  const blocks = [];
  for (const { heading, entries } of categories) {
    if (entries.length === 0) continue;
    blocks.push(`### ${heading}\n\n${entries.map((e) => renderEntry(e, { repoUrl, extractHeadsUpsFn })).join("\n\n")}`);
  }
  const footer = `---\n\nFull record: [CHANGELOG.md](${changelogTagUrl(version, repoUrl)})`;
  const body = blocks.join("\n\n");
  return (body ? `${body}\n\n${footer}\n` : `${footer}\n`);
}

export function renderReleaseNotesFromFile(version, changelogPath = "CHANGELOG.md", opts = {}) {
  const section = extractChangelogSection(version, changelogPath);
  return renderReleaseNotes(section, { version, ...opts });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  try {
    const notes = renderReleaseNotesFromFile(process.argv[2], process.argv[3]);
    process.stdout.write(notes.endsWith("\n") ? notes : notes + "\n");
  } catch (err) {
    const prefix = err instanceof ExtractError ? "" : "changelog-release-notes: ";
    console.error(`${prefix}${err?.message ?? err}`);
    process.exit(err instanceof ExtractError ? err.exitCode : 1);
  }
}
