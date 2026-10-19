import { describe, expect, test } from "bun:test";
import {
  AdminPassEmptyError,
  AdminPassSourceError,
  resolveAdminPassFromSources,
} from "../../src/lib/auth-resolve";

describe("admin credential option presence", () => {
  test("absent explicit options allow the ambient password", () => {
    expect(resolveAdminPassFromSources({ envPass: "ambient" })).toBe("ambient");
    expect(resolveAdminPassFromSources({})).toBe("");
  });

  for (const option of ["adminPassFile", "adminPass"] as const) {
    test(`empty ${option} refuses instead of using the ambient password`, () => {
      const resolve = () => resolveAdminPassFromSources({ [option]: "", envPass: "ambient" });
      expect(resolve).toThrow(AdminPassEmptyError);
      expect(resolve).toThrow(`${option === "adminPassFile" ? "--admin-pass-file" : "--admin-pass"} must not be empty`);
    });
  }

  for (const [adminPassFile, adminPass] of [["", "x"], ["file", ""], ["", ""], ["file", "x"]]) {
    test(`file ${JSON.stringify(adminPassFile)} and password ${JSON.stringify(adminPass)} conflict`, () => {
      const resolve = () => resolveAdminPassFromSources({ adminPassFile, adminPass, envPass: "ambient" });
      expect(resolve).toThrow(AdminPassSourceError);
      expect(resolve).toThrow("--admin-pass and --admin-pass-file cannot be combined");
    });
  }

  test("a nonempty explicit password overrides the ambient password", () => {
    expect(resolveAdminPassFromSources({ adminPass: "explicit", envPass: "ambient" })).toBe("explicit");
  });
});
