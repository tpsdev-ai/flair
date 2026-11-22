/**
 * path-id-rewrite-2845.test.ts — the detection a route uses to refuse a path
 * agent id that Harper's path parsing changed (flair#2845).
 *
 * The received ids come from Harper's installed parser: RequestTarget decodes
 * the remainder and Resource.parsePath, called with a request context the way
 * Harper's REST layer calls it, may change it. The real-Harper route cases live
 * in test/integration/agent-id-path-rewrite-2845.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  AGENT_ID_REWRITTEN_ERROR,
  refuseRewrittenAgentId,
  rewrittenPathId,
} from "../../resources/path-id-rewrite.ts";

const req = createRequire(import.meta.url);
const harperDist = join(dirname(req.resolve("harper/package.json")), "dist", "resources");
const { RequestTarget } = req(join(harperDist, "RequestTarget.js"));
const { Resource } = req(join(harperDist, "Resource.js"));

/** The id a plain Resource route receives for `remainder`, per Harper's parser. */
function receivedByRoute(remainder: string): string {
  const target = new RequestTarget(remainder);
  const parsed = Resource.parsePath.call(class extends Resource {}, target.id, { headers: {} }, target);
  return typeof parsed === "string" ? parsed : String(parsed?.id);
}

const encodeDots = (id: string) => encodeURIComponent(id).replace(/\./g, "%2E");

describe("rewrittenPathId against Harper's parser", () => {
  for (const ext of ["json", "csv", "cbor", "msgpack"]) {
    for (const segment of [`agent.${ext}`, encodeDots(`agent.${ext}`)]) {
      test(`/Route/${segment}: Harper passes "agent", and both ids are reported`, () => {
        const received = receivedByRoute(segment);
        expect(received).toBe("agent");
        expect(rewrittenPathId(`/Route/${segment}?limit=2`, received)).toEqual({ requested: `agent.${ext}`, received: "agent" });
      });
    }
  }

  test("/Route/agent%2Fx.json: an encoded slash before the suffix is decoded first, then the suffix is removed", () => {
    const received = receivedByRoute("agent%2Fx.json");
    expect(received).toBe("agent/x");
    expect(rewrittenPathId("/Route/agent%2Fx.json", received)).toEqual({ requested: "agent/x.json", received: "agent/x" });
  });

  // A raw `#` does not end the path Harper reads, so it stays in the id and in
  // the text after the id's first dot.
  for (const [segment, expected] of [["agent#x.json", "agent#x"], ["#x.json", "#x"], ["agent%23x.json", "agent#x"]]) {
    test(`/Route/${segment}: Harper passes ${JSON.stringify(expected)}, and both ids are reported`, () => {
      const received = receivedByRoute(segment);
      expect(received).toBe(expected);
      expect(rewrittenPathId(`/Route/${segment}?limit=2`, received)).toEqual({ requested: decodeURIComponent(segment), received: expected });
    });
  }

  // Harper looks the text after the first dot up in a plain object, so a name
  // inherited from Object.prototype counts as a content-type extension.
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    test(`/Route/agent.${name}: Harper passes "agent", and both ids are reported`, () => {
      const received = receivedByRoute(`agent.${name}`);
      expect(received).toBe("agent");
      expect(rewrittenPathId(`/Route/agent.${name}`, received)).toEqual({ requested: `agent.${name}`, received: "agent" });
    });
  }

  for (const segment of ["agent", "agent.a", encodeDots("agent.a"), "agent.a.json", "a/b", "x%20y", "agent#x", "agent.json#x", "agent#x?limit=2"]) {
    test(`/Route/${segment}: the id Harper passes is the path's own, so nothing is reported`, () => {
      const received = receivedByRoute(segment);
      expect(received).toBe(decodeURIComponent(segment.split("?")[0]!));
      expect(rewrittenPathId(`/Route/${segment}`, received)).toBeNull();
    });
  }
});

describe("rewrittenPathId edge cases", () => {
  test("no URL, an empty URL and a non-string URL report nothing", () => {
    expect(rewrittenPathId(undefined, "agent")).toBeNull();
    expect(rewrittenPathId("", "agent")).toBeNull();
    expect(rewrittenPathId(42, "agent")).toBeNull();
  });

  test("a path with nothing after its first segment reports nothing", () => {
    expect(rewrittenPathId("/Route", "agent")).toBeNull();
    expect(rewrittenPathId("/Route?agentId=x", "agent")).toBeNull();
  });

  test("the query is not part of the compared id", () => {
    expect(rewrittenPathId("/Route/agent?after=agent.json", "agent")).toBeNull();
  });

  test("an absolute URL is compared on its path, cut the way Harper's BunRequest cuts it", () => {
    expect(rewrittenPathId("http://localhost/Route/agent?limit=2", "agent")).toBeNull();
    expect(rewrittenPathId("http://localhost/Route/agent%2Ejson", "agent")).toEqual({ requested: "agent.json", received: "agent" });
    expect(rewrittenPathId("http://localhost/Route/agent#x", "agent#x")).toBeNull();
    expect(rewrittenPathId("http://localhost/Route/#x.json", "#x")).toEqual({ requested: "#x.json", received: "#x" });
    expect(rewrittenPathId("http://[/Route/agent", "agent")).toBeNull();
    expect(rewrittenPathId("http://localhost", "agent")).toBeNull();
  });

  test("a remainder that is not valid percent-encoding is reported undecoded", () => {
    expect(rewrittenPathId("/Route/agent%E0%A4%A", "agent")).toEqual({ requested: "agent%E0%A4%A", received: "agent" });
  });
});

describe("refuseRewrittenAgentId", () => {
  test("answers a named 400 naming both ids when the request path's id was changed", async () => {
    for (const context of [{ request: { url: "/Route/agent.json" } }, { url: "/Route/agent.json" }]) {
      const res = refuseRewrittenAgentId(context, "agent");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      const body = await res!.json() as any;
      expect(body.error).toBe(AGENT_ID_REWRITTEN_ERROR);
      expect(body.requestedAgentId).toBe("agent.json");
      expect(body.receivedAgentId).toBe("agent");
    }
  });

  test("returns null when the route received the path's own id, or there is no request", () => {
    expect(refuseRewrittenAgentId({ request: { url: "/Route/agent.json" } }, "agent.json")).toBeNull();
    expect(refuseRewrittenAgentId(undefined, "agent")).toBeNull();
    expect(refuseRewrittenAgentId({}, "agent")).toBeNull();
  });
});
