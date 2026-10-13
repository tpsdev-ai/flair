import { describe, expect, it } from "bun:test";
import {
  GRANT_VISIBILITY_REFUSAL,
  applyGrantedVisibility,
  grantVisibilityRefusal,
  grantedSuccessorVisibilityDenial,
  readVisibility,
  visibilityChanges,
} from "../../resources/grant-visibility";

describe("grant-visibility: a write grant does not include changing a record's visibility", () => {
  it("reads visibility with the read predicate: only the literal private is private", () => {
    expect(readVisibility("private")).toBe("private");
    expect(readVisibility("shared")).toBe("shared");
    expect(readVisibility(undefined)).toBe("shared");
    expect(readVisibility(null)).toBe("shared");
  });

  it("a change is a change in who can read, in either direction", () => {
    expect(visibilityChanges("private", "shared")).toBe(true);
    expect(visibilityChanges("shared", "private")).toBe(true);
    expect(visibilityChanges(undefined, "private")).toBe(true);
    expect(visibilityChanges("private", "private")).toBe(false);
    expect(visibilityChanges(undefined, "shared")).toBe(false);
  });

  it("refuses a named visibility that reads differently, and leaves the body unchanged", async () => {
    for (const [prior, requested] of [["private", "shared"], ["shared", "private"]] as const) {
      const content: Record<string, any> = { visibility: requested };
      const res = applyGrantedVisibility(content, { visibility: prior }, requested);
      expect(res?.status).toBe(403);
      expect(await res!.json()).toEqual({
        error: GRANT_VISIBILITY_REFUSAL,
        message: "a write grant does not include changing a record's visibility; visibility is set by the owner or an admin",
      });
      expect(content.visibility).toBe(requested);
    }
  });

  it("an omitted visibility carries the predecessor's over any default already on the body", () => {
    for (const requested of [undefined, null]) {
      const content: Record<string, any> = { visibility: "shared" };
      expect(applyGrantedVisibility(content, { visibility: "private" }, requested)).toBeNull();
      expect(content.visibility).toBe("private");
    }
    const legacy: Record<string, any> = { visibility: "private" };
    expect(applyGrantedVisibility(legacy, {}, undefined)).toBeNull();
    expect(legacy.visibility).toBe("shared");
  });

  it("a named visibility equal to the predecessor's lands", () => {
    const content: Record<string, any> = { visibility: "private" };
    expect(applyGrantedVisibility(content, { visibility: "private" }, "private")).toBeNull();
    expect(content.visibility).toBe("private");
  });

  it("the skill-version writer check applies only to a grant-authorized successor", () => {
    const grantedClose = { granteeId: "g", ownerId: "o" };
    const pred = { visibility: "private" };
    expect(grantedSuccessorVisibilityDenial({ kind: "update", predecessor: pred, successor: { visibility: "shared" }, grantedClose })?.status).toBe(403);
    expect(grantedSuccessorVisibilityDenial({ kind: "update", predecessor: pred, successor: { visibility: "private" }, grantedClose })).toBeNull();
    expect(grantedSuccessorVisibilityDenial({ kind: "update", predecessor: pred, successor: { visibility: "shared" }, grantedClose: null })).toBeNull();
    expect(grantedSuccessorVisibilityDenial({ kind: "create", predecessor: null, successor: { visibility: "shared" }, grantedClose: null })).toBeNull();
    expect(grantedSuccessorVisibilityDenial({ kind: "delete", predecessor: pred, grantedClose })).toBeNull();
  });

  it("the refusal is a fixed 403", async () => {
    const res = grantVisibilityRefusal();
    expect(res.status).toBe(403);
    expect(Object.keys(await res.json()).sort()).toEqual(["error", "message"]);
  });
});
