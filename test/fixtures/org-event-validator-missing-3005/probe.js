// org-event-validator-missing-3005 — TEST-ONLY resource for flair#3005's
// missing-validator case on the A2A message/send handler.
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-org-event-validator-missing-3005.js. Nothing under
// resources/ or src/ references it and it is never packed or shipped.
//
// It does two things:
//   - makes the OrgEvent table's own `validate` method unavailable until the
//     explicit validator-restore action, so validateServerRow finds no
//     validator to call;
//   - wraps the OrgEvent table's own `put`, so every row the staging call
//     receives is appended to <ROOTPATH>/org-event-validator-missing-3005/staged.jsonl
//     before the original put runs. The `staged` action reads that file, so the
//     test can assert no row reached staging.
import { Resource, databases } from "harper";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ROOTPATH;
const OUT_DIR = ROOT ? join(ROOT, "org-event-validator-missing-3005") : null;
const STAGED = OUT_DIR ? join(OUT_DIR, "staged.jsonl") : null;

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

const OrgEvent = databases.flair.OrgEvent;
let savedValidate;

const originalPut = OrgEvent.put;
OrgEvent.put = function (record, ...rest) {
  recordStaged(record);
  return originalPut.call(this, record, ...rest);
};

export class OrgEventValidatorMissingProbe extends Resource {
  allowCreate() {
    return true;
  }

  async post({ action } = {}) {
    if (action === "staged") return { staged: readStaged() };
    if (action === "reset") {
      resetStaged();
      return { reset: true };
    }
    if (action === "validator-absent") {
      if (savedValidate === undefined) {
        savedValidate = Object.getOwnPropertyDescriptor(OrgEvent.prototype, "validate") ?? null;
      }
      // Define the property as a non-function value rather than deleting it:
      // the generated table prototype is a tracked proxy, and reading a
      // property it no longer holds goes through getProxiedProperty, which
      // throws on a bare prototype object.
      Object.defineProperty(OrgEvent.prototype, "validate", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const descriptor = Object.getOwnPropertyDescriptor(OrgEvent.prototype, "validate");
      return {
        hadValidator: typeof savedValidate?.value === "function",
        absent: typeof descriptor?.value !== "function",
      };
    }
    if (action === "validator-restore") {
      if (savedValidate) Object.defineProperty(OrgEvent.prototype, "validate", savedValidate);
      savedValidate = undefined;
      const descriptor = Object.getOwnPropertyDescriptor(OrgEvent.prototype, "validate");
      return { restored: typeof descriptor?.value === "function" };
    }
    throw new Error("unknown probe action");
  }
}
