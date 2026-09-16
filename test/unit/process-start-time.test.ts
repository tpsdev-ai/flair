// The I/O adapter around daemon-liveness parsers. One reader — production
// daemon identity and the #1372 scratch-owner stamp share it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStartTimeMatch } from "../../src/lib/daemon-liveness.js";
import {
  applyLstartZoneOffset,
  readProcessStartTimeMs,
} from "../../src/lib/process-start-time.js";

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "process-start-time.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("readProcessStartTimeMs — shared start-time reader (flair#1372)", () => {
  test("reuses daemon-liveness parsers, does not reimplement them", () => {
    expect(CODE).toMatch(/parseProcStatStartTime/);
    expect(CODE).toMatch(/procStartTimeToEpochMs/);
    expect(CODE).toMatch(/parsePsLstart/);
    expect(CODE).toMatch(/applyLstartZoneOffset/);
    expect(CODE).toMatch(/process\.uptime/);
    expect(CODE).not.toMatch(/lastIndexOf\("\)"\)/);
    expect(CODE).not.toMatch(/Date\.parse/);
  });

  test("applyLstartZoneOffset cancels an injected zone skew (Kern #1708 PDT vs bun-test UTC)", () => {
    const trueOwn = 1_000_000;
    const trueTarget = 1_500_000;
    const skew = 7 * 60 * 60 * 1000;
    expect(applyLstartZoneOffset(trueTarget + skew, trueOwn + skew, trueOwn)).toBe(trueTarget);
    expect(applyLstartZoneOffset(trueTarget, trueOwn, trueOwn)).toBe(trueTarget);
    // Rockit: bun test parses lstart as UTC, stamp was written in PDT.
    // UTC parse is 7h behind the PDT stamp (1789508177000 vs 1789533377000).
    const utcParse = 1_789_508_177_000;
    const pdtStamp = 1_789_533_377_000;
    expect(pdtStamp - utcParse).toBe(skew);
    expect(applyLstartZoneOffset(utcParse, trueOwn - skew, trueOwn)).toBe(pdtStamp);
  });

  test("reads this process as a plausible past epoch", () => {
    const ms = readProcessStartTimeMs(process.pid);
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(ms as number).toBeLessThanOrEqual(Date.now());
    const again = readProcessStartTimeMs(process.pid);
    expect(again).not.toBeNull();
    expect(isStartTimeMatch(ms!, again!)).toBe(true);
  });

  test("a non-positive or missing pid is null — fail closed", () => {
    expect(readProcessStartTimeMs(0)).toBeNull();
    expect(readProcessStartTimeMs(-1)).toBeNull();
    expect(readProcessStartTimeMs(2_147_000_000)).toBeNull();
  });
});
