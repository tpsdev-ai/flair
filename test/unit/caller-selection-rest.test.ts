/**
 * caller-selection-rest.test.ts — flair#1940 slice 1, round 15.
 *
 * `restSelection` reads the two REST forms Harper parses BEFORE it dispatches
 * to the resource — `?select(...)` (`resources/search.ts` `parseQuery`) and a
 * `.<name>` suffix on the id (`/Memory/<id>.<name>`, `resources/Resource.ts`
 * `parsePath`). The auth middleware runs first and sees only the URL, so it
 * needs this to refuse a selection that is not an array of plain Memory schema
 * attribute names BEFORE its Memory pre-read.
 *
 * `restSelection` reports the raw form (it keeps empty segments and flags the
 * nested-list form); `parseCallerSelection` applies the narrowed contract: an
 * array of plain Memory schema attribute names only, everything else 400.
 */
import { describe, it, expect } from "bun:test";
import { restSelection, parseCallerSelection } from "../../resources/caller-selection.ts";

describe("round 15 — restSelection reads Harper's REST selection and path-property forms", () => {
  it("reads select(...) names verbatim: one name is a scalar, several are an array", () => {
    expect(restSelection("/Memory/x", "?select(a,b)")).toEqual({ select: ["a", "b"] }); // assertion: several names → array
    expect(restSelection("/Memory/x", "select(content)")).toEqual({ select: "content" }); // assertion: one name → scalar
    // Empty segments are KEPT, not dropped: a trailing/doubled comma is refused.
    expect(restSelection("/Memory/x", "?select(content,)")).toEqual({ select: ["content", ""] }); // assertion: trailing comma kept
    expect(restSelection("/Memory/x", "?select(a,,b)")).toEqual({ select: ["a", "", "b"] }); // assertion: doubled comma kept
    // The nested-list form is flagged `asArray` — an option attached to the array.
    const asArr = restSelection("/Memory/x", "select((a,b))");
    expect(asArr?.select).toEqual(["a", "b"]); // assertion: nested-list names
    expect((asArr?.select as any).asArray).toBe(true); // assertion: nested list → asArray option
    expect(restSelection("/Memory/x.hostSource", "")).toEqual({ property: "hostSource" }); // assertion: path property
    // round 16 (blocker 1): Harper DECODES the path before property parsing, so
    // an encoded dot is a dot — the middleware must see the same property.
    expect(restSelection("/Memory/x%2EhostSource", "")).toEqual({ property: "hostSource" }); // assertion: encoded dot decoded
    // ... and a content-type extension is NOT a property (Harper strips it).
    expect(restSelection("/Memory/x.json", "")).toBeNull(); // assertion: .json is a content type, not a property
    expect(restSelection("/Memory/x.cbor", "")).toBeNull(); // assertion: .cbor too
    expect(restSelection("/Memory/x", "")).toBeNull(); // assertion: neither form → null
  });

  it("the LAST select(...) wins (Harper re-assigns query.select on each call)", () => {
    expect(restSelection("/Memory/x", "?select(content),select(id,agentId)"))
      .toEqual({ select: ["id", "agentId"] }); // assertion: the effective (last) selection
    expect(restSelection("/Memory/x", "?select(id,agentId),select(*)"))
      .toEqual({ select: "*" }); // assertion: a later wildcard is the effective selection
  });

  it("an array of plain Memory schema names is accepted; every other form is refused 400", () => {
    const adk = ["id", "agentId", "content", "metadata", "subject", "tags", "createdAt"];
    expect(parseCallerSelection(adk, undefined)).toEqual({ shape: "keys", keys: adk }); // assertion: the ADK array shape accepted

    const refused: unknown[] = [
      restSelection("/Memory/x", "?select(*)")?.select,           // wildcard
      restSelection("/Memory/x", "select(content)")?.select,      // scalar
      restSelection("/Memory/x", "?select(content,)")?.select,    // trailing comma
      restSelection("/Memory/x", "?select(a,,b)")?.select,        // doubled comma
      restSelection("/Memory/x", "select((a,b))")?.select,        // asArray option attached
      [],                                                          // empty
      ["content", "noSuchField"],                                  // name not in the schema
      { nested: true },                                            // select object
    ];
    for (const sel of refused) {
      const parsed = parseCallerSelection(sel, undefined);
      expect(parsed instanceof Response, `select ${JSON.stringify(sel)}`).toBe(true); // assertion: refused
      expect((parsed as Response).status).toBe(400); // assertion: 400
    }
    expect(parseCallerSelection(undefined, "content") instanceof Response).toBe(true); // assertion: a path property is refused
  });
});
