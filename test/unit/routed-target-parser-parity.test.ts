/**
 * routed-target-parser-parity.test.ts — a differential check of the pure
 * request-target helpers against Harper's installed parser, over a corpus.
 *
 * At request time the middleware resolves a target through Harper's OWN routing
 * (resources/harper-routing.ts) for its by-name and by-id decisions, so for those
 * the helpers here are the fallback used when the live registry is absent (a unit
 * mock), when the target matches no route, or when the matcher throws. The
 * middleware's non-admin Memory-selection rewrite also calls them on the live
 * request. This test fixes the fallback to Harper's parser for the part it covers —
 * the id over the whole remainder (`RequestTarget`) and the first-dot
 * DECLARED-ATTRIBUTE property rule (`Resource.parsePath` with no request context).
 * Harper's content-type-suffix rule fires only with a request context; the final
 * group below checks that behaviour directly against Harper (it is what
 * harper-routing relies on), and the pure fallback deliberately does not reproduce
 * it, so a content-type suffix (`x.json`) is stripped by the live routing and left
 * whole by the fallback.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  routedRecordId,
  routedResourceAndRemainder,
  routedIdAfterPropertyRule,
} from "../../resources/request-target.ts";

// Harper's package `exports` map hides its internal modules, so resolve the
// compiled parser by the package root and load the files directly.
const req = createRequire(import.meta.url);
const harperDist = join(dirname(req.resolve("harper/package.json")), "dist", "resources");
const { RequestTarget } = req(join(harperDist, "RequestTarget.js"));
const { Resource } = req(join(harperDist, "Resource.js"));

// A fixture resource whose declared attributes stand in for a real table's.
const DECLARED = ["content", "agentId", "tags", "trigger"];
const DECLARED_SET = new Set(DECLARED);
const fixtureResource = { attributes: DECLARED.map((name) => ({ name })) };

/** The id Harper resolves for `/<resource>/<remainder>`: RequestTarget over the
 *  remainder, then its first-dot property rule via Resource.parsePath. */
function harperId(remainder: string): { id: unknown; property?: unknown } {
  const target = new RequestTarget(remainder);
  const parsed = Resource.parsePath.call(fixtureResource, target.id, undefined, undefined);
  if (parsed && typeof parsed === "object") return { id: parsed.id, property: parsed.property };
  return { id: parsed };
}

describe("routedRecordId matches Harper's RequestTarget id (no property rule)", () => {
  const remainders = [
    "plain",
    "safe/victim", // multi-segment remainder is ONE id
    "a/b/c",
    "a%2Fb", // encoded slash
    "a%2fb",
    "alice%3Amission", // encoded colon
    "a.b", // dot inside, no declared suffix
    "a.b/x.agentId", // first dot's suffix is not a declared attribute
    "some.id.content",
    "x%20y",
    "a%2F%2Fb",
  ];
  for (const remainder of remainders) {
    test(`/Fixture/${remainder}`, () => {
      const routed = routedRecordId(`/Fixture/${remainder}`);
      const harper = new RequestTarget(remainder);
      expect(routed).not.toBeNull();
      expect(routed!.resource).toBe("Fixture");
      expect(routed!.id).toBe(harper.id);
    });
  }

  test("a collection path and a trailing-slash remainder resolve to no single record", () => {
    expect(routedRecordId("/Fixture")).toBeNull();
    expect(routedRecordId("/Fixture/")).toBeNull();
    // Harper flags an empty remainder as a collection with a null id. A
    // trailing-slash remainder that keeps text (`x/`) is also a collection
    // (isCollection true) but carries a non-null id (`x/`).
    expect(new RequestTarget("").id ?? null).toBeNull();
    expect(new RequestTarget("x/").isCollection).toBe(true);
    expect(new RequestTarget("x/").id).toBe("x/");
  });

  test("a remainder that is not valid percent-encoding resolves to null", () => {
    expect(routedRecordId("/Fixture/bad%E0%A4")).toBeNull();
  });
});

describe("routedIdAfterPropertyRule matches Harper's Resource.parsePath", () => {
  const ids = [
    "x.content", // declared suffix → stripped
    "x.agentId",
    "x.tags",
    "a.b", // not declared → kept
    "some.id.content", // first dot's suffix `id.content` not declared → kept
    "mcs-slash/base.content", // first dot is `.content` → stripped
    "a.b/x.agentId", // first dot's suffix not declared → kept
    "plain",
    "x.json", // content-type ext, not a declared attribute → kept by this rule
  ];
  for (const id of ids) {
    test(id, () => {
      const harper = harperId(id);
      const mine = routedIdAfterPropertyRule(id, DECLARED_SET);
      expect(mine).toBe(harper.id as string);
    });
  }
});

describe("routedResourceAndRemainder splits where Harper routes", () => {
  test("first segment is the resource, the rest is the remainder", () => {
    expect(routedResourceAndRemainder("/Asset/safe/victim")).toEqual({ resource: "Asset", remainder: "safe/victim" });
    expect(routedResourceAndRemainder("/Memory/a%2Fb")).toEqual({ resource: "Memory", remainder: "a%2Fb" });
    expect(routedResourceAndRemainder("/Memory")).toEqual({ resource: "Memory", remainder: "" });
    expect(routedResourceAndRemainder("/Memory/")).toEqual({ resource: "Memory", remainder: "" });
  });
});

describe("Harper's content-type-suffix rule (what harper-routing relies on)", () => {
  // With a request context, Harper STRIPS a recognised content-type extension
  // and returns the bare id; the middleware's live path (harper-routing.ts)
  // calls parsePath with the request headers, so the resolved id is the row.
  const withCtx = (id: string) => Resource.parsePath.call(fixtureResource, id, { headers: {} }, undefined);
  for (const ext of ["json", "cbor", "msgpack", "csv"]) {
    test(`\`x.${ext}\` strips to \`x\` with a request context`, () => {
      expect(withCtx(`x.${ext}`)).toBe("x");
    });
    test(`\`x.${ext}\` without a context is left whole (no headers → no strip)`, () => {
      expect(Resource.parsePath.call(fixtureResource, `x.${ext}`, undefined, undefined)).toBe(`x.${ext}`);
    });
  }
  test("an unrecognised extension is left whole even with a context", () => {
    expect(withCtx("x.yaml")).toBe("x.yaml");
  });
  test("a declared attribute is still a property selector, not a content type", () => {
    const parsed: any = withCtx("x.content");
    expect(parsed).toEqual({ id: "x", property: "content" });
  });
});
