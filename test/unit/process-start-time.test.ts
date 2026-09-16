// The I/O adapter around daemon-liveness parsers. One reader — production
// daemon identity and the #1372 scratch-owner stamp share it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStartTimeMatch } from "../../src/lib/daemon-liveness.js";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.js";

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "process-start-time.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("readProcessStartTimeMs — shared start-time reader (flair#1372)", () => {
  test("reuses daemon-liveness parsers, does not reimplement them", () => {
    expect(CODE).toMatch(/parseProcStatStartTime/);
    expect(CODE).toMatch(/procStartTimeToEpochMs/);
    expect(CODE).toMatch(/parsePsLstart/);
    expect(CODE).not.toMatch(/lastIndexOf\("\)"\)/);
    expect(CODE).not.toMatch(/Date\.parse/);
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
