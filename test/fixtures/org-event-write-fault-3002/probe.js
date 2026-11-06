// org-event-write-fault-3002 — TEST-ONLY resource for flair#3002's
// invalid-server-row cases for the OrgEvent writers that build their row on
// the server (A2A message/send and agent-key-register).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-org-event-write-fault-3002.js. Nothing under resources/ or
// src/ references it and it is never packed or shipped.
//
// It installs the writer hook: a row whose owning agent id starts with
// `fault-mutate-<site>-` gets a non-string summary, which the table validator
// must refuse.
import { setOrgEventWriteFaultHook } from "./org-event-write-fault.js";

const PREFIX = "fault-mutate-";

setOrgEventWriteFaultHook((site, row) => {
  const owner = site === "a2a" ? row?.scope : row?.refId;
  if (typeof owner !== "string" || !owner.startsWith(`${PREFIX}${site}-`)) return;
  row.summary = 123;
});
