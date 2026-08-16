/**
 * bootstrap-events.test.ts — unit coverage for the flair#1200 zero-row no-op
 * auto-heal event suppressor. Pure/Harper-free, so it drives the real shipped
 * helper (resources/memory-bootstrap-lib.ts) against the exact detail shapes the
 * migration ledger (resources/migrations/ledger.ts::buildLedgerDetail) and the
 * graph-heal path (resources/migrations/graph-heal.ts::writeGraphHealEvent) emit.
 */
import { describe, expect, test } from "bun:test";
import { isZeroRowNoOpEvent } from "../../resources/memory-bootstrap-lib";

// Mirrors buildLedgerDetail's output for a given outcome/rows.
const ledgerDetail = (migrationId: string, outcome: string, rowsProcessed: number) =>
  JSON.stringify({ migrationId, initiator: "boot", fromVersion: "0", toVersion: "1", scope: "full",
    startedAt: "t0", endedAt: "t1", outcome, rowsProcessed, rowsRemaining: 0, hashEnvelopeMatch: true });

// Mirrors writeGraphHealEvent's detail blob.
const graphHealDetail = (verified: boolean) =>
  JSON.stringify({ migrationId: "graph-heal", verified, canaryRank1: verified,
    embeddedVectorCount: 549, runningVersion: "1", verifiedAt: "t" });

describe("isZeroRowNoOpEvent — suppressed (zero-signal boot noise)", () => {
  test("ledger success with 0 rows", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: ledgerDetail("embedding-stamp", "success", 0) })).toBe(true);
  });
  test("the graph-heal LEDGER event (migrationId graph-heal, 0 rows, success — no `verified`)", () => {
    // Regression guard: the graph-heal branch must not early-return before the
    // rowsProcessed:0 check swallows this half of the near-identical pair.
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: ledgerDetail("graph-heal", "success", 0) })).toBe(true);
  });
  test("the graph-heal VERIFICATION event (verified:true, no rowsProcessed)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: graphHealDetail(true) })).toBe(true);
  });
  test("detail already parsed to an object (not a JSON string)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: { migrationId: "x", outcome: "success", rowsProcessed: 0 } })).toBe(true);
  });
});

describe("isZeroRowNoOpEvent — kept (actionable / has signal)", () => {
  test("a migration that PROCESSED rows", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: ledgerDetail("visibility-backfill", "success", 42) })).toBe(false);
  });
  test("a HALTED migration at 0 rows (worth surfacing)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: ledgerDetail("x", "halted", 0) })).toBe(false);
  });
  test("a FAILED migration at 0 rows (worth surfacing)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: ledgerDetail("x", "failed", 0) })).toBe(false);
  });
  test("an UNCONFIRMED graph-heal (verified:false)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: graphHealDetail(false) })).toBe(false);
  });
  test("a non-migration event (a real status/handoff)", () => {
    expect(isZeroRowNoOpEvent({ kind: "status", detail: JSON.stringify({ rowsProcessed: 0 }) })).toBe(false);
    expect(isZeroRowNoOpEvent({ kind: "handoff", summary: "pick this up" } as any)).toBe(false);
  });
  test("a migration with unparseable / missing detail (don't guess)", () => {
    expect(isZeroRowNoOpEvent({ kind: "migration", detail: "not json {{{" })).toBe(false);
    expect(isZeroRowNoOpEvent({ kind: "migration" })).toBe(false);
  });
  test("null / undefined events", () => {
    expect(isZeroRowNoOpEvent(null)).toBe(false);
    expect(isZeroRowNoOpEvent(undefined)).toBe(false);
  });
});
