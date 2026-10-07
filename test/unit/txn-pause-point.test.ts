/**
 * txn-pause-point.test.ts — flair#2307: the test-only pause inside an owned
 * transaction (resources/txn-pause-point.ts) is inert unless every condition
 * holds, pauses one call per arm file, and releases on `go` or on its limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV, txnPausePoint } from "../../resources/txn-pause-point.ts";

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

describe("an armed point pauses one call until go", () => {
  it("claims the arm, marks paused, waits for go, and records the release", async () => {
    arm();
    const pause = txnPausePoint("supersede-close", env());
    expect(pause).toBeInstanceOf(Promise);
    expect(txnPausePoint("supersede-close", env())).toBeUndefined(); // one arm, one pause
    let released = false;
    void pause!.then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(released).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["claimed.supersede-close", "paused.supersede-close"]);
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
