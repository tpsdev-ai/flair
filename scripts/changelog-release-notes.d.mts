/** Typings for `changelog-release-notes.mjs` — GitHub release lede + links (flair#1392). */

export const DEFAULT_REPO_URL: string;
export const MAX_ISSUE_LINKS: number;

export function collapseWs(s: string): string;
export function extractBoldLede(entryText: string): string | null;
export function fallbackLede(entryText: string): string;
export function ledeForEntry(entryText: string): string;
export function extractIssueRefs(entryText: string, limit?: number): string[];
export function extractHeadsUps(entryText: string): string[];

export interface ChangelogCategory {
  heading: string;
  entries: string[];
}

export function parseChangelogEntries(section: string): ChangelogCategory[];
export function issueLink(n: string, repoUrl?: string): string;
export function changelogTagUrl(version: string, repoUrl?: string): string;

export interface RenderReleaseNotesOptions {
  version: string;
  repoUrl?: string;
  extractHeadsUpsFn?: (entryText: string) => string[];
}

export function renderReleaseNotes(section: string, opts: RenderReleaseNotesOptions): string;
export function renderReleaseNotesFromFile(
  version: string,
  changelogPath?: string,
  opts?: Omit<RenderReleaseNotesOptions, "version">,
): string;
