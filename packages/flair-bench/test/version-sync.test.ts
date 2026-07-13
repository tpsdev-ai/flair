import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { TOOL_VERSION } from "../src/version.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("TOOL_VERSION stays in sync with package.json", () => {
  test("matches package.json's version field", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    expect(TOOL_VERSION).toBe(pkg.version);
  });
});
