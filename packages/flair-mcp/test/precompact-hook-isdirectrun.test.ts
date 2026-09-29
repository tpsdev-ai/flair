// The PreCompact hook's entry-point check (isDirectRun): where import.meta.main
// is unavailable (Node 22 before 22.18), the fallback compares filesystem paths
// resolved through symlinks, so a path with a space or an npm bin symlink still
// runs the hook, and a defined import.meta.main always decides.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectRun } from "../src/precompact-hook.ts";

describe("precompact hook isDirectRun", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flair precompact entry "));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a path containing a space matches (the module URL is percent-encoded)", () => {
    const file = join(dir, "precompact-hook.js");
    writeFileSync(file, "");
    const url = pathToFileURL(file).href;
    expect(url).toContain("%20");
    expect(isDirectRun(url, file, undefined)).toBe(true);
  });

  test("an npm-style bin symlink to the module matches", () => {
    const file = join(dir, "precompact-hook.js");
    writeFileSync(file, "");
    const shim = join(dir, "flair-precompact");
    symlinkSync(file, shim);
    expect(isDirectRun(pathToFileURL(file).href, shim, undefined)).toBe(true);
  });

  test("another script, a missing argv[1] and an unresolvable path do not match", () => {
    const file = join(dir, "precompact-hook.js");
    const other = join(dir, "other.js");
    writeFileSync(file, "");
    writeFileSync(other, "");
    const url = pathToFileURL(file).href;
    expect(isDirectRun(url, other, undefined)).toBe(false);
    expect(isDirectRun(url, undefined, undefined)).toBe(false);
    expect(isDirectRun(url, join(dir, "missing.js"), undefined)).toBe(false);
  });

  test("a defined import.meta.main decides, true or false", () => {
    const file = join(dir, "precompact-hook.js");
    writeFileSync(file, "");
    expect(isDirectRun("file:///nowhere/x.js", undefined, true)).toBe(true);
    expect(isDirectRun(pathToFileURL(file).href, file, false)).toBe(false);
  });
});
