/**
 * routed-target-parser-parity.test.ts — the request-target helpers derive the
 * SAME record id and property that Harper's own routing does.
 *
 * The oracle is Harper's installed parser: `RequestTarget` (which sets
 * `id = decodeURIComponent(path)` over the whole resource-relative remainder)
 * and `Resource.parsePath` (its first-dot property rule). The helpers in
 * resources/request-target.ts must agree with it, so what the middleware decides
 * about is exactly the row Harper operates on.
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
    // Harper flags these as collections (id null / isCollection true).
    expect(new RequestTarget("").id ?? null).toBeNull();
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
