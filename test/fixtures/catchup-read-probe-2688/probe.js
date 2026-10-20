// catchup-read-probe-2688 — TEST-ONLY resource for flair#2688's A2A
// message/stream test (test/integration/a2a-message-stream-2688.test.ts).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-catchup-read-probe-2688.js. Nothing under resources/
// references it and it is never packed or shipped.
//
// It records every OrgEventCatchup read, whatever its entry (an in-process
// static call or an HTTP GET), as one JSON line in
// <ROOTPATH>/catchup-read-probe-2688/reads.jsonl: the participant read, the
// identity the read's context carried (tpsAgent / tpsAgentIsAdmin), whether
// the context came from an HTTP request (it has headers), and when it started.
// The read itself is delegated unchanged.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OrgEventCatchup } from "./OrgEventCatchup.js";

const ROOT = process.env.ROOTPATH;
const OUT = ROOT ? join(ROOT, "catchup-read-probe-2688") : null;

const original = OrgEventCatchup.prototype.get;

OrgEventCatchup.prototype.get = function probedCatchupGet(pathInfo, ...rest) {
  if (OUT) {
    const context = this.getContext?.() ?? null;
    const request = context?.request ?? context;
    const participantId =
      (pathInfo && typeof pathInfo === "object" ? pathInfo.id : typeof pathInfo === "string" ? pathInfo : null) ?? null;
    const record = {
      participantId: participantId == null ? null : String(participantId),
      tpsAgent: request?.tpsAgent == null ? null : String(request.tpsAgent),
      tpsAgentIsAdmin: request?.tpsAgentIsAdmin === true,
      http: Boolean(request?.headers),
      at: Date.now(),
    };
    mkdirSync(OUT, { recursive: true });
    appendFileSync(join(OUT, "reads.jsonl"), JSON.stringify(record) + "\n");
  }
  return original.call(this, pathInfo, ...rest);
};

console.log("[catchup-read-probe-2688] OrgEventCatchup.prototype.get recorded");
