/**
 * risk-policy.ts — risk class → safety posture (Kern verdict, 2026-07-12):
 * "Risk-class governs the WHOLE safety posture, not just snapshot scope:
 * batch size (derived-only 50 / schema-additive 50 / content-transform 10)
 * AND completion-gate strictness (derived-only: row-count + stamp
 * convergence, no content-hash — recomputable; schema-additive: count +
 * full envelope; content-transform: envelope over OLD rows' SOURCE_FIELDS +
 * new-row presence — strictest)."
 *
 * Snapshot scope (flair#695 invariant III, space
 * pressure step 3): derived-only → metadata-only (no corpus snapshot
 * needed — recomputable by definition); schema-additive → schema+metadata
 * (no row rewrites); content-transform → pointers+metadata (old rows are
 * retained in-store via supersession, so the corpus itself doesn't need
 * snapshotting — only the pointer/metadata state that proves which rows
 * were touched).
 */
import type { RiskClass } from "./types.js";

export type SnapshotScope = "metadata-only" | "schema+metadata" | "pointers+metadata";
export type GateStrictness =
  | "count+marker" // derived-only
  | "count+full-envelope" // schema-additive
  | "count+old-row-envelope+new-row-presence"; // content-transform

export interface RiskPosture {
  riskClass: RiskClass;
  batchSize: number;
  snapshotScope: SnapshotScope;
  gate: GateStrictness;
}

const POSTURE: Record<RiskClass, RiskPosture> = {
  "derived-only": {
    riskClass: "derived-only",
    batchSize: 50,
    snapshotScope: "metadata-only",
    gate: "count+marker",
  },
  "schema-additive": {
    riskClass: "schema-additive",
    batchSize: 50,
    snapshotScope: "schema+metadata",
    gate: "count+full-envelope",
  },
  "content-transform": {
    riskClass: "content-transform",
    batchSize: 10,
    snapshotScope: "pointers+metadata",
    gate: "count+old-row-envelope+new-row-presence",
  },
};

export function postureFor(riskClass: RiskClass): RiskPosture {
  return POSTURE[riskClass];
}
