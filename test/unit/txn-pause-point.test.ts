/**
 * txn-pause-point.test.ts — flair#2307: the test-only pause inside an owned
 * transaction (resources/txn-pause-point.ts) is inert unless every condition
 * holds, claims an arm file, and releases on `go` or on its limit.
 * flair#2382: it also refuses a pause-point name that is not lowercase words and
 * hyphens at call time, and this file scans the source for the names in use.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidPausePointError, PAUSE_POINT_PATTERN, TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV, txnPausePoint } from "../../resources/txn-pause-point.ts";

let dir: string;
const env = (overrides: Record<string, string | undefined> = {}) => ({
  [TEST_FAULT_INJECTION_ENV]: "1",
  [TEST_PAUSE_DIR_ENV]: dir,
  ...overrides,
}) as NodeJS.ProcessEnv;
const arm = () => writeFileSync(join(dir, "arm.supersede-close"), "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-txn-pause-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("logs filesystem refusals once", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: "relative" }));
    txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: "relative" }));
    expect(warning.mock.calls.length).toBe(1);
  } finally {
    warning.mockRestore();
  }
});

describe("txnPausePoint is inert unless every condition holds", () => {
  it("no opt-in, a non-exact opt-in, or no pause dir → undefined, and the arm file is left alone", () => {
    arm();
    for (const e of [
      env({ [TEST_FAULT_INJECTION_ENV]: undefined }),
      env({ [TEST_FAULT_INJECTION_ENV]: "true" }),
      env({ [TEST_FAULT_INJECTION_ENV]: " 1" }),
      env({ [TEST_PAUSE_DIR_ENV]: undefined }),
      env({ [TEST_PAUSE_DIR_ENV]: "relative/dir" }),
      env({ [TEST_PAUSE_DIR_ENV]: "/" }),
    ]) {
      expect(txnPausePoint("supersede-close", e)).toBeUndefined();
    }
    expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
  });

  it("the production environment (neither variable set) → undefined", () => {
    expect(txnPausePoint("supersede-close", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("opted in but not armed → undefined, no file written", () => {
    expect(txnPausePoint("supersede-close", env())).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an arm for another point does not pause this one", () => {
    writeFileSync(join(dir, "arm.embedding-stamp-content-suffix"), "");
    expect(txnPausePoint("supersede-close", env())).toBeUndefined();
  });
});

describe("an armed point releases on go or timeout", () => {
  it("claims the arm, marks paused, waits for go, and records the release", async () => {
    arm();
    const pause = txnPausePoint("supersede-close", env());
    expect(pause).toBeInstanceOf(Promise);
    expect(txnPausePoint("supersede-close", env())).toBeUndefined(); // the arm has been consumed
    let released = false;
    void pause!.then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(released).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["claimed.supersede-close", "paused.supersede-close", "released.supersede-close"]);
    writeFileSync(join(dir, "go.supersede-close"), "");
    await pause;
    expect(readFileSync(join(dir, "released.supersede-close"), "utf8")).toBe("go");
  });

  it("releases itself at its limit and records a timeout", async () => {
    arm();
    const pause = txnPausePoint("supersede-close", env(), 60);
    await pause;
    expect(readFileSync(join(dir, "released.supersede-close"), "utf8")).toBe("timeout");
  });
});


describe("pause filesystem refusals", () => {
  it("refuses a symlinked directory", () => {
    arm();
    const link = join(dir, "alias");
    symlinkSync(dir, link);
    expect(txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: link }), 0)).toBeUndefined();
    expect(readFileSync(join(dir, "arm.supersede-close"), "utf8")).toBe("");
  });

  it("refuses a directory symlink that resolves outside the temp root", () => {
    arm();
    const saved = process.env.TMPDIR;
    const scopedTemp = mkdtempSync(join(dir, "scoped-"));
    const link = join(scopedTemp, "alias");
    symlinkSync(dir, link);
    process.env.TMPDIR = scopedTemp;
    try {
      expect(txnPausePoint("supersede-close", env({ [TEST_PAUSE_DIR_ENV]: link }), 0)).toBeUndefined();
      expect(readFileSync(join(dir, "arm.supersede-close"), "utf8")).toBe("");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it("refuses a directory whose owner differs from the current uid", () => {
    arm();
    const uid = process.getuid!();
    const uidSpy = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
    } finally {
      uidSpy.mockRestore();
    }
  });

  for (const mode of [0o720, 0o702]) {
    it(`refuses directory write permissions ${mode.toString(8)}`, () => {
      arm();
      chmodSync(dir, mode);
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readdirSync(dir)).toEqual(["arm.supersede-close"]);
    });
  }

  for (const marker of ["claimed", "paused", "released"]) {
    it(`refuses a pre-existing ${marker} marker`, () => {
      arm();
      const path = join(dir, `${marker}.supersede-close`);
      writeFileSync(path, "existing");
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("existing");
    });

    it(`refuses a symlink at the ${marker} marker path`, () => {
      arm();
      const target = join(dir, "marker-target");
      writeFileSync(target, "existing");
      symlinkSync(target, join(dir, `${marker}.supersede-close`));
      expect(txnPausePoint("supersede-close", env(), 0)).toBeUndefined();
      expect(readFileSync(target, "utf8")).toBe("existing");
    });
  }

});

describe("pause-point names (flair#2382)", () => {
  // The trees that may name a pause point. resources/ and src/ both compile
  // into the published dist/, so a name in either is a call site.
  const roots = ["resources", "src"].map((name) => fileURLToPath(new URL(`../../${name}`, import.meta.url)));

  function collectTs(source: string, found: string[] = []): string[] {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const full = join(source, entry.name);
      if (entry.isDirectory()) collectTs(full, found);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
    return found;
  }

  it("each literal txnPausePoint(\"...\") name in resources/ and src/ is well-formed and unique", () => {
    const calls: { name: string; where: string }[] = [];
    for (const file of roots.flatMap((root) => collectTs(root))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/txnPausePoint\(\s*"([^"]*)"\s*[,)]/g)) {
        calls.push({ name: match[1], where: file });
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !PAUSE_POINT_PATTERN.test(call.name))).toEqual([]);
    const seen = new Set<string>();
    const duplicates = calls.filter((call) => {
      if (seen.has(call.name)) return true;
      seen.add(call.name);
      return false;
    });
    expect(duplicates).toEqual([]);
  });

  it("refuses a malformed name at call time with a named error", () => {
    for (const bad of ["Bad Name", "no_underscores", "-leading", "trailing-", "double--hyphen", ""]) {
      expect(() => txnPausePoint(bad, {} as NodeJS.ProcessEnv)).toThrow(InvalidPausePointError);
    }
  });
});
