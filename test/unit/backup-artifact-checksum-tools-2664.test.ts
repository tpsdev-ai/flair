/**
 * backup-artifact-checksum-tools-2664.test.ts — flair#2664 slice 1b: the
 * standard checksum utilities verify a published backup pair.
 *
 * Each case publishes a pair with publishBackupArtifact (the function `flair
 * backup` publishes with) into a temp directory and runs the REAL tool from
 * that directory with a minimal environment: perl `shasum -a 256 -c` and
 * `sha256sum -c`. A tool that is not installed skips its cases, but the first
 * case fails when the tools CI relies on are missing: `shasum` on Linux and
 * macOS, and GNU `sha256sum` on Linux. The real `flair backup` command's own
 * output is checked with `shasum` in restore-archive-backup-seam-2664.test.ts.
 *
 * Covered: an ordinary file name; a name with a backslash and a name with a
 * line feed (escaped form) for the tools that read escapes; a changed archive,
 * which every tool must report as failed. The BSD `sha256sum` that ships with
 * macOS reads only unescaped lines; one case pins that it does not check an
 * escaped line.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { findChecksumTools, runChecksumTool, type ChecksumTool } from "../helpers/checksum-tools.ts";
import { publishBackupArtifact } from "../../src/lib/backup-artifact.ts";

const tools = findChecksumTools();
const ARCHIVE = JSON.stringify({ version: 1, agents: [{ id: "flint" }], souls: [], memories: [] }, null, 2) + "\n";

function publish(name: string): { dir: string; archive: string; sidecarName: string } {
  const dir = tempDir("flair-backup-checksum-tool-2664-");
  const archive = join(dir, name);
  publishBackupArtifact({ outputPath: archive, serialized: ARCHIVE });
  return { dir, archive, sidecarName: `${name}.sha256` };
}

function expectVerifies(tool: ChecksumTool, name: string): void {
  const { dir, archive, sidecarName } = publish(name);
  const intact = runChecksumTool(tool, dir, sidecarName);
  expect(intact.status, intact.output).toBe(0);
  expect(intact.output).toContain("OK");
  appendFileSync(archive, " ");
  const changed = runChecksumTool(tool, dir, sidecarName);
  expect(changed.status, changed.output).not.toBe(0);
  expect(changed.output).toContain("FAILED");
}

describe("real checksum utilities verify a published backup pair (#2664)", () => {
  test("the tools CI relies on are installed on this platform", () => {
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(tools.shasum, "shasum must be on PATH on Linux and macOS").toBeDefined();
    }
    if (process.platform === "linux") {
      expect(tools.sha256sum?.escapes, "GNU sha256sum must be on PATH on Linux").toBe(true);
    }
  });

  for (const key of ["shasum", "sha256sum"] as const) {
    const tool = tools[key];
    const label = tool?.label ?? key;
    test.skipIf(tool === undefined)(`${label}: an ordinary file name verifies, and a changed archive fails`, () => {
      expectVerifies(tool!, "flair-backup-2026-10-19T00-00-00.json");
    });
    test.skipIf(tool === undefined || !tool.escapes)(`${label}: a file name with a backslash verifies in the escaped form, and a changed archive fails`, () => {
      expectVerifies(tool!, "back\\slash.json");
    });
    test.skipIf(tool === undefined || !tool.escapes)(`${label}: a file name with a line feed verifies in the escaped form, and a changed archive fails`, () => {
      expectVerifies(tool!, "line\nbreak.json");
    });
  }

  test.skipIf(tools.sha256sum === undefined || tools.sha256sum.escapes)("non-GNU sha256sum: an escaped line is reported as not a checksum line, not as verified", () => {
    const { dir, sidecarName } = publish("back\\slash.json");
    const result = runChecksumTool(tools.sha256sum!, dir, sidecarName);
    expect(result.output).toContain("improperly formatted");
    expect(result.output).not.toContain(": OK");
  });
});
