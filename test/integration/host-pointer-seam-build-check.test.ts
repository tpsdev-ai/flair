/**
 * host-pointer-seam-build-check.test.ts — flair#1940 A1-iv item 6.
 *
 * The production tree ships NO failure-injection seam: the failing pointer-table
 * adapter is driven from TEST code (the shared Harper mock), never by a switch
 * under resources/ or src/. This check reads the BUILT output and fails if the
 * seam symbol (or any FLAIR_TEST_FAIL_* failure switch) appears in ANY file
 * under dist/, at any depth — not just top-level dist/resources/*.js. It
 * requires a build (the integration lane builds before running).
 *
 * A positive control plants the seam's symbol in a temporary nested dist file
 * and proves the scan goes RED before any real assertion is judged.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "dist");
const SEAM_SYMBOL = "setHostPointerAdapterForTests";
const FAIL_SWITCH = "FLAIR_TEST_FAIL";

/** Every offender under `dir`, walking recursively (node_modules skipped). */
function scanForSeams(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(p);
      } else if (entry.name.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        if (src.includes(SEAM_SYMBOL)) offenders.push(`${p}: seam setter`);
        if (src.includes(FAIL_SWITCH)) offenders.push(`${p}: ${FAIL_SWITCH} switch`);
      }
    }
  };
  walk(dir);
  return offenders;
}

describe("flair#1940 A1-iv item 6 — production output has no pointer failure switch", () => {
  it("(build) the seam symbol and any FLAIR_TEST_FAIL switch are absent from every file under dist/", () => {
    expect(existsSync(DIST), `build first: ${DIST} is absent`).toBe(true);
    expect(scanForSeams(DIST)).toEqual([]); // assertion: no seam/switch anywhere under dist/
  });

  it("(positive control) a planted NESTED dist file makes the scan FAIL, then its removal restores green", () => {
    const nestedDir = join(DIST, "resources", "nested-scratch");
    const planted = join(nestedDir, "planted.js");
    mkdirSync(nestedDir, { recursive: true });
    try {
      // A symbol in a nested file is EXACTLY what a top-level-only glob misses.
      writeFileSync(planted, `exports.${SEAM_SYMBOL} = function () {};\n`);
      expect(scanForSeams(DIST)).toContain(`${planted}: seam setter`); // assertion: the scan is RED
    } finally {
      rmSync(nestedDir, { recursive: true, force: true });
    }
    expect(scanForSeams(DIST)).toEqual([]); // assertion: green again once removed
  });
});
