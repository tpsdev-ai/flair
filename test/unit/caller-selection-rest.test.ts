/**
 * caller-selection-rest.test.ts — flair#1940 slice 1, round 14.
 *
 * `restSelection` reproduces the two REST forms Harper parses BEFORE it
 * dispatches to the resource — `?select(...)` (search.ts `parseQuery`) and a
 * `.<name>` suffix on the id (`/Memory/<id>.<name>`, Resource.ts `parsePath`).
 * The auth middleware runs first and sees only the URL, so it needs this to
 * refuse an unsupported selection before its Memory pre-read (blocker 5).
 */
import { describe, it, expect } from "bun:test";
import { restSelection, parseCallerSelection } from "../../resources/caller-selection.ts";

describe("round 14 — restSelection reads Harper's REST selection and path-property forms", () => {
  it("extracts select(...) names, the asArray nested form, and a path property", () => {
    expect(restSelection("/Memory/x", "?select(a,b)")).toEqual({ select: ["a", "b"] }); // assertion: several names
    expect(restSelection("/Memory/x", "select(hostSource)")).toEqual({ select: "hostSource" }); // assertion: one name
    const asArr = restSelection("/Memory/x", "select((a,b))");
    expect(asArr?.select).toEqual(["a", "b"]); // assertion: nested list names
    expect((asArr?.select as any).asArray).toBe(true); // assertion: nested list → asArray
    expect(restSelection("/Memory/x.hostSource", "")).toEqual({ property: "hostSource" }); // assertion: path property
    expect(restSelection("/Memory/x", "?select(content,)")).toEqual({ select: "content" }); // assertion: trailing comma is a separator artifact
    expect(restSelection("/Memory/x", "")).toBeNull(); // assertion: neither form → null
  });

  it("an unsupported REST select is refused by parseCallerSelection", () => {
    const sel = restSelection("/Memory/x", "?select(*)");
    const parsed = parseCallerSelection(sel?.select, sel?.property, { surface: "byId" });
    expect(parsed instanceof Response).toBe(true); // assertion: refused
    expect((parsed as Response).status).toBe(400); // assertion: 400
  });
});
