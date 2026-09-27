/**
 * host-pointer-seam-build-check.test.ts — flair#1940 A1-iv item 6.
 *
 * The failing pointer-table adapter is injected by TESTS through a seam that
 * lives OUTSIDE the resource surface (resources/host-pointer/registry.ts, which
 * is not under dist/resources/*.js). This check reads the BUILT output and
 * fails if the seam symbol (or any FLAIR_TEST_FAIL_* failure switch) leaked
 * into the loaded resource surface. It requires a build (the integration lane
 * builds before running).
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST_RESOURCES = join(import.meta.dir, "..", "..", "dist", "resources");

describe("flair#1940 A1-iv item 6 — production output has no pointer failure switch", () => {
  it("(build) the seam symbol and any FLAIR_TEST_FAIL switch are absent from dist/resources/*.js", () => {
    expect(existsSync(DIST_RESOURCES), `build first: ${DIST_RESOURCES} is absent`).toBe(true);
    const files = readdirSync(DIST_RESOURCES).filter((n) => n.endsWith(".js"));
    const offenders: string[] = [];
    for (const name of files) {
      const src = readFileSync(join(DIST_RESOURCES, name), "utf8");
      if (src.includes("setHostPointerAdapterForTests")) offenders.push(`${name}: seam setter`);
      if (src.includes("FLAIR_TEST_FAIL")) offenders.push(`${name}: FLAIR_TEST_FAIL switch`);
    }
    expect(offenders).toEqual([]); // assertion: no seam/switch in the resource surface
  });
});
