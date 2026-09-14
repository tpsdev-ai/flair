/** Typings for `first-publish-check.mjs` (flair#1674). */

export type LookupState = "live" | "missing" | "error";

export interface LookupResult {
  state: LookupState;
  version?: string;
  error?: string;
}

export type Lookup = (name: string) => Promise<LookupResult>;

export interface PublishTarget {
  name: string;
  source: string;
}

export interface Enumeration {
  targets: PublishTarget[];
  problems: string[];
}

export interface ApprovalEntry {
  name: string;
  approver: string;
  date: string;
  reason: string;
}

export interface ParsedApprovals {
  approvedNames: Set<string>;
  entries: ApprovalEntry[];
  problems: string[];
}

export interface CannotConfirm {
  name: string;
  error: string;
}

export interface CheckResult {
  root: string;
  targets: PublishTarget[];
  live: Array<PublishTarget & { version: string }>;
  firstPublishes: string[];
  approved: string[];
  unapproved: string[];
  cannotConfirm: CannotConfirm[];
  approvalEntries: ApprovalEntry[];
  problems: string[];
  blocked: boolean;
}

export const OUR_SCOPE: string;
export const ALLOW_LIST_REL: string;

export function parseNpmAliasTarget(spec: unknown): string | null;
export function enumeratePublishTargets(root?: string): Enumeration;
export function parseApprovals(raw: string, source?: string): ParsedApprovals;
export function lookupViaNpm(
  name: string,
  options?: { registry?: string; timeoutMs?: number },
): Promise<LookupResult>;
export function runCheck(options?: {
  root?: string;
  lookup?: Lookup;
  allowListPath?: string;
  readFile?: (path: string) => string;
}): Promise<CheckResult>;
export function formatReport(result: CheckResult): string;
export function formatSuccess(result: CheckResult): string;
