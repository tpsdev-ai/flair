// catchup-read-probe-2688 — TEST-ONLY resource for flair#2688's A2A
// message/stream test (test/integration/a2a-message-stream-2688.test.ts).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-catchup-read-probe-2688.js. Nothing under resources/
// references it and it is never packed or shipped.
//
// It records two things:
//   - every OrgEventCatchup read, whatever its entry (an in-process static call
//     or an HTTP GET), as one JSON line in
//     <ROOTPATH>/catchup-read-probe-2688/reads.jsonl: the participant read, the
//     identity the read's context carried (tpsAgent / tpsAgentIsAdmin), whether
//     the context came from an HTTP request (it has headers), and when it
//     started;
//   - every dispatch that reaches the A2A adapter's inherited (default)
//     connect or its post handler, as one JSON line in
//     <ROOTPATH>/catchup-read-probe-2688/dispatch.jsonl: the kind of dispatch,
//     the HTTP method, and when it ran.
// Each wrapped call is delegated unchanged.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Resource } from "harper";
import { OrgEventCatchup } from "./OrgEventCatchup.js";
import { A2AAdapter } from "./A2AAdapter.js";

const ROOT = process.env.ROOTPATH;
const OUT = ROOT ? join(ROOT, "catchup-read-probe-2688") : null;

function record(name, row) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, name), JSON.stringify(row) + "\n");
}

function requestOf(resource) {
  const context = resource.getContext?.() ?? null;
  return context?.request ?? context;
}

const originalGet = OrgEventCatchup.prototype.get;

OrgEventCatchup.prototype.get = function probedCatchupGet(pathInfo, ...rest) {
  if (OUT) {
    const request = requestOf(this);
    const participantId =
      (pathInfo && typeof pathInfo === "object" ? pathInfo.id : typeof pathInfo === "string" ? pathInfo : null) ?? null;
    record("reads.jsonl", {
      participantId: participantId == null ? null : String(participantId),
      tpsAgent: request?.tpsAgent == null ? null : String(request.tpsAgent),
      tpsAgentIsAdmin: request?.tpsAgentIsAdmin === true,
      http: Boolean(request?.headers),
      at: Date.now(),
    });
  }
  return originalGet.call(this, pathInfo, ...rest);
};

const originalConnect = Resource.prototype.connect;

Resource.prototype.connect = function probedDefaultConnect(target, incomingMessages) {
  if (OUT) {
    const request = requestOf(this);
    record("dispatch.jsonl", {
      kind: "connect",
      method: request?.method == null ? null : String(request.method),
      at: Date.now(),
    });
  }
  return originalConnect.call(this, target, incomingMessages);
};

const originalPost = A2AAdapter.prototype.post;

A2AAdapter.prototype.post = function probedA2APost(...args) {
  if (OUT) {
    const request = requestOf(this);
    record("dispatch.jsonl", {
      kind: "post",
      method: request?.method == null ? null : String(request.method),
      at: Date.now(),
    });
  }
  return originalPost.apply(this, args);
};

console.log("[catchup-read-probe-2688] OrgEventCatchup.get and A2A dispatch recorded");
