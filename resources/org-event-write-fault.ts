/**
 * org-event-write-fault.ts — the injection point for a per-site fault in the
 * selected server-built OrgEvent writers (flair#3002): the A2A
 * message/send event, the agent-key-register event and the graph-heal event.
 *
 * The hook is null unless setOrgEventWriteFaultHook installs one. Nothing
 * under resources/ or src/ calls it; the real-Harper suite installs it from
 * test/fixtures/org-event-write-fault-3002/probe.js, which is not in the
 * package. The row is the exact object about to be validated and staged, so a
 * test fixture can hand the writer a row its table's validator must refuse.
 */

export type OrgEventWriteSite = "a2a" | "agent-key-register" | "graph-heal";

export type OrgEventWriteFaultHook = (site: OrgEventWriteSite, row: Record<string, any>) => void;

let hook: OrgEventWriteFaultHook | null = null;

export function setOrgEventWriteFaultHook(next: OrgEventWriteFaultHook | null): void {
  hook = next;
}

/** Run the installed hook for `site`; a no-op when none is installed. */
export function maybeFaultOrgEventRow(site: OrgEventWriteSite, row: Record<string, any>): void {
  hook?.(site, row);
}
