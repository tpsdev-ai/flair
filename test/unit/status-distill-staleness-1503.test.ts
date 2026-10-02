/**
 * status-distill-staleness-1503.test.ts — `flair status` must not render a
 * stale zero as a healthy zero (flair#1503, sharpened by the #924 comment).
 *
 * The pure decision + text helpers are pinned here without Harper, matching
 * `formatBm25StatusLine` (flair#2032). resources/health.ts supplies
 * `lastDistilledAt` from the nightly log; these two functions decide how the
 * status surfaces read it beside the pending-candidate count.
 */
import { describe, test, expect } from "bun:test";
import {
  distillationStaleness,
  distillStalenessLine,
  DISTILL_STALE_AFTER_MS,
} from "../../src/commands/status.ts";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const relative = (iso: string) => `${Math.round((NOW - Date.parse(iso)) / 86_400_000)} days ago`;

describe("distillationStaleness (flair#1503)", () => {
  test("zero pending with fresh distillation is a healthy zero (not stale)", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: 0, lastDistilledAt: days(0) },
      NOW,
    );
    expect(ds.stale).toBe(false);
    expect(ds.lastDistilledAt).toBe(days(0));
  });

  test("zero pending with distillation older than the threshold is stale", () => {
    const last = days(DISTILL_STALE_AFTER_MS / 86_400_000 + 1);
    const ds = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: 0, lastDistilledAt: last },
      NOW,
    );
    expect(ds.stale).toBe(true);
    expect(distillStalenessLine(ds, relative)).toContain("distillation has not run recently");
  });

  test("zero pending and distillation that never ran is stale — never a healthy zero", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: 0, lastDistilledAt: null },
      NOW,
    );
    expect(ds.stale).toBe(true);
    expect(distillStalenessLine(ds, relative)).toBe("never — distillation has not run recently");
  });

  test("pending work is never flagged as a stale zero", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: 3, lastDistilledAt: days(60) },
      NOW,
    );
    expect(ds.stale).toBe(false);
  });

  test("nightly explicitly disabled suppresses the stale signal", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: false, pendingCandidates: 0, lastDistilledAt: null },
      NOW,
    );
    expect(ds.stale).toBe(false);
  });

  test("unknown nightly state is not treated as healthy", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: null, pendingCandidates: 0, lastDistilledAt: days(60) },
      NOW,
    );
    expect(ds.stale).toBe(true);
  });

  test("missing pending count (no schema) yields no verdict", () => {
    const ds = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: null, lastDistilledAt: days(60) },
      NOW,
    );
    expect(ds.stale).toBe(false);
  });

  test("the stale marker is appended only when stale", () => {
    const fresh = distillationStaleness(
      { nightlyEnabled: true, pendingCandidates: 0, lastDistilledAt: days(0) },
      NOW,
    );
    expect(distillStalenessLine(fresh, relative)).toBe("0 days ago");
  });
});
