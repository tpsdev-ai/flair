// org-event-write-fault-3002 — TEST-ONLY resource for flair#3002's
// invalid-server-row cases for the OrgEvent writers that build their row on
// the server (A2A message/send, agent-key-register and graph-heal).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-org-event-write-fault-3002.js. Nothing under resources/ or
// src/ references it and it is never packed or shipped.
//
// It does two things:
//   - installs the writer hook: a row whose owning agent id starts with
//     `fault-mutate-<site>-` gets a non-string summary, which the table
//     validator must refuse; the graph-heal action installs the same fault
//     on demand;
//   - wraps the OrgEvent table's own `put`, so every row the staging call
//     receives is appended to <ROOTPATH>/org-event-write-fault-3002/staged.jsonl
//     before the original put runs. The probe's `staged` action reads that
//     file, so the test can assert an invalid row never reaches staging.
import { Resource, databases } from "harper";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setOrgEventWriteFaultHook } from "./org-event-write-fault.js";
import { createGraphHealMigration } from "./migrations/graph-heal.js";

const PREFIX = "fault-mutate-";
const ROOT = process.env.ROOTPATH;
const OUT_DIR = ROOT ? join(ROOT, "org-event-write-fault-3002") : null;
const STAGED = OUT_DIR ? join(OUT_DIR, "staged.jsonl") : null;

let graphHealCorrupt = false;

function recordStaged(row) {
  if (!STAGED) return;
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(STAGED, JSON.stringify({
    id: row?.id ?? null,
    refId: row?.refId ?? null,
    scope: row?.scope ?? null,
    summaryType: typeof row?.summary,
    summary: typeof row?.summary === "string" ? row.summary : null,
  }) + "\n");
}

function readStaged() {
  if (!STAGED) return [];
  try {
    return readFileSync(STAGED, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function resetStaged() {
  if (!STAGED) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(STAGED, "");
}

setOrgEventWriteFaultHook((site, row) => {
  if (site === "graph-heal") {
    if (graphHealCorrupt) row.summary = 123;
    return;
  }
  const owner = site === "a2a" ? row?.scope : row?.refId;
  if (typeof owner !== "string" || !owner.startsWith(`${PREFIX}${site}-`)) return;
  row.summary = 123;
});

const OrgEvent = databases.flair.OrgEvent;
const originalPut = OrgEvent.put;
OrgEvent.put = function (record, ...rest) {
  recordStaged(record);
  return originalPut.call(this, record, ...rest);
};

export class OrgEventWriteProbe extends Resource {
  allowCreate() {
    return true;
  }

  async post({ action, corrupt } = {}) {
    if (action === "staged") return { staged: readStaged() };
    if (action === "reset") {
      resetStaged();
      return { reset: true };
    }
    if (action === "graph-heal") {
      graphHealCorrupt = corrupt === true;
      try {
        const result = await createGraphHealMigration().run(0);
        return { result, staged: readStaged(), corrupt: graphHealCorrupt };
      } finally {
        graphHealCorrupt = false;
      }
    }
    throw new Error("unknown probe action");
  }
}
