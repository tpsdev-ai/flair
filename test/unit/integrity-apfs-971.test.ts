/**
 * integrity-apfs-971.test.ts — flair#971 slice 1a.
 *
 * Runs custody initialization against a real APFS directory in the macOS CI
 * lane. macOS reports the same numeric `f_type` for local disk filesystems,
 * so the refusal must classify APFS by name.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSupportedLocalFilesystem } from "../../src/lib/config-critical-section.ts";
import {
  commitGeneration,
  generationNumbers,
  initializeIntegrityCustody,
  integrityPaths,
} from "../../src/lib/integrity-state.ts";

const isDarwin = process.platform === "darwin";

describe("apfs custody (invariant 1)", () => {
  it.skipIf(!isDarwin)("initializes custody in a real APFS directory", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-971-apfs-"));
    try {
      const custodyDir = join(root, "custody");
      const support = assertSupportedLocalFilesystem(root);
      expect(support.ok).toBe(true);
      if (support.ok) expect(support.type).toBe("apfs");

      const operatorUid = process.getuid?.() ?? 0;
      const result = initializeIntegrityCustody({
        custodyDir,
        serverUid: operatorUid + 1000,
        serverUidSource: "measured",
        operatorUid,
        newCustody: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const committed = commitGeneration({
        state: result.state,
        expectedGeneration: 0,
        checkpoint: {
          baseline: {
            scannedAt: "2026-11-04T00:00:00.000Z",
            scanStartedAt: "2026-11-04T00:00:00.000Z",
            scanEndedAt: "2026-11-04T00:00:01.000Z",
            clockSource: "test",
            byDurability: { permanent: 1, persistent: 0, standard: 0, ephemeral: 0 },
            ids: { "mem-a": "permanent" },
            instanceTokens: { "mem-a": "tok-a" },
          },
        },
      });
      expect(committed.ok).toBe(true);
      expect(generationNumbers(integrityPaths(custodyDir))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
