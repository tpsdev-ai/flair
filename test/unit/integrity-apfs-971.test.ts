/**
 * integrity-apfs-971.test.ts — flair#971 slice 1a.
 *
 * Runs custody initialization against a real APFS directory in the macOS CI
 * lane.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { assertSupportedLocalFilesystem, classifyDarwinFilesystem, parseDfMountPoint, parseMountLine, selectMountEntry } from "../../src/lib/config-critical-section.ts";
import {
  commitGeneration,
  generationNumbers,
  initializeIntegrityCustody,
  integrityPaths,
} from "../../src/lib/integrity-state.ts";

const isDarwin = process.platform === "darwin";

// Fixed df and mount outputs; these tests run on every OS.
const ROOT_LINE = "/dev/disk3s1 on / (hfs, local, journaled)";
const APFS_LINE = "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)";
const SPACE_LINE = "/dev/disk4s1 on /Volumes/Data Disk (apfs, local, nodev, nosuid, journaled)";
const SMB_LINE = "//operator-a@host-a/share on /Volumes/Net (smbfs, nodev, nosuid, mounted by operator-a)";
const APFS_NO_LOCAL_LINE = "/dev/disk6s1 on /Volumes/Net (apfs, noexec, nobrowse)";
const DATA_DF = "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100000 40000 60000 40% /System/Volumes/Data\n";
const NET_DF = "Filesystem 512-blocks Used Available Capacity Mounted on\n//operator-a@host-a/share 100000 40000 60000 40% /Volumes/Net\n";
const SPACE_DF = "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/Data Disk 100000 40000 60000 40% /Volumes/Data Disk\n";

describe("macOS mount table classification", () => {
  it("parses device, mount point, type and options", () => {
    const entry = parseMountLine(APFS_LINE);
    expect(entry).not.toBeNull();
    if (entry === null) return;
    expect(entry.device).toBe("/dev/disk3s5");
    expect(entry.mountPoint).toBe("/System/Volumes/Data");
    expect(entry.type).toBe("apfs");
    expect(entry.options).toEqual(["local", "journaled", "nobrowse", "protect", "root data"]);
  });

  it("returns null for output that does not match the mount shape", () => {
    expect(parseMountLine("not a mount line")).toBeNull();
    expect(parseMountLine("/dev/disk1 on /mnt without parentheses")).toBeNull();
  });

  it("accepts the Data covering mount reported for a Users path", () => {
    const calls: string[] = [];
    const support = classifyDarwinFilesystem("/Users/operator/custody", `${ROOT_LINE}\n${APFS_LINE}`, (path) => {
      calls.push(path);
      return DATA_DF;
    });
    expect(calls).toEqual(["/Users/operator/custody"]);
    expect(support).toEqual({ ok: true, type: "apfs" });
  });

  it("refuses the covering smbfs mount with the same device name as a local mount", () => {
    const local = "//operator-a@host-a/share on / (apfs, local)";
    const support = classifyDarwinFilesystem("/Volumes/Net/custody", `${local}\n${SMB_LINE}`, () => NET_DF);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("not a recognized local filesystem");
  });

  it("selects a df mount point that contains a space", () => {
    expect(parseDfMountPoint(SPACE_DF)).toBe("/Volumes/Data Disk");
    const support = classifyDarwinFilesystem("/Volumes/Data Disk/custody", `${ROOT_LINE}\n${SPACE_LINE}`, () => SPACE_DF);
    expect(support).toEqual({ ok: true, type: "apfs" });
  });

  it("refuses unparseable mount output", () => {
    const support = classifyDarwinFilesystem("/Users/operator", "not a mount line", () => DATA_DF);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("unparseable mount entry");
  });

  it("refuses an apfs covering mount without local and accepts it with local", () => {
    const table = `${ROOT_LINE}\n${APFS_NO_LOCAL_LINE}`;
    const support = classifyDarwinFilesystem("/Volumes/Net/custody", table, () => NET_DF);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("not a recognized local filesystem");
    expect(classifyDarwinFilesystem("/Volumes/Net/custody", table.replace("apfs, noexec", "apfs, local, noexec"), () => NET_DF))
      .toEqual({ ok: true, type: "apfs" });
  });

  it("refuses df timeout and nonzero exit", () => {
    for (const error of [Object.assign(new Error("df timed out"), { code: "ETIMEDOUT" }), Object.assign(new Error("df exited"), { status: 1 })]) {
      const support = classifyDarwinFilesystem("/Users/operator", APFS_LINE, () => { throw error; });
      expect(support.ok).toBe(false);
      if (!support.ok) expect(support.reason).toContain("cannot read the covering mount");
    }
  });

  it("refuses unparseable or ambiguous df output", () => {
    for (const output of ["", "not a df line", DATA_DF + DATA_DF, DATA_DF.replace("/System/Volumes/Data", "relative")]) {
      expect(classifyDarwinFilesystem("/Users/operator", APFS_LINE, () => output).ok).toBe(false);
    }
  });

  it("refuses a df response with an unexpected line beside one valid row", () => {
    for (const output of [
      `garbage\n${DATA_DF}`,
      `${DATA_DF}garbage\n`,
      DATA_DF.replace("\n", "\ngarbage\n"),
    ]) {
      expect(parseDfMountPoint(output)).toBeNull();
      const support = classifyDarwinFilesystem("/Users/operator", APFS_LINE, () => output);
      expect(support.ok).toBe(false);
      if (!support.ok) expect(support.reason).toBe("unparseable df output");
    }
    expect(parseDfMountPoint(DATA_DF)).toBe("/System/Volumes/Data");
    expect(parseDfMountPoint(DATA_DF.replace("512-blocks", "1024-blocks"))).toBe("/System/Volumes/Data");
    expect(parseDfMountPoint(NET_DF)).toBe("/Volumes/Net");
    expect(parseDfMountPoint(SPACE_DF)).toBe("/Volumes/Data Disk");
  });

  it("refuses a df header with unexpected columns", () => {
    const output = DATA_DF.replace("Filesystem 512-blocks Used Available Capacity Mounted on", "Filesystem garbage");
    expect(parseDfMountPoint(output)).toBeNull();
    const support = classifyDarwinFilesystem("/Users/operator", APFS_LINE, () => output);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe("unparseable df output");
  });

  it("requires exactly one mount entry equal to the df mount point", () => {
    const entries = [parseMountLine(ROOT_LINE)!, parseMountLine(APFS_LINE)!];
    expect(selectMountEntry(entries, "/System/Volumes/Data")?.mountPoint).toBe("/System/Volumes/Data");
    for (const table of [ROOT_LINE, `${ROOT_LINE}\n/dev/disk3s5 on /System/Volumes (apfs, local)`, `${APFS_LINE}\n${APFS_LINE}`]) {
      const support = classifyDarwinFilesystem("/Users/operator", table, () => DATA_DF);
      expect(support.ok).toBe(false);
      if (!support.ok) expect(support.reason).toContain("no unique mount entry");
    }
  });

  it.skipIf(!isDarwin)("matches the real home path to the Data volume apfs local mount", () => {
    const path = realpathSync(userInfo().homedir);
    const table = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000 });
    const df = execFileSync("/bin/df", ["-P", path], { encoding: "utf8", timeout: 5000 });
    const entries = table.trim().split("\n").map(parseMountLine);
    expect(entries.every((entry) => entry !== null)).toBe(true);
    const mountPoint = parseDfMountPoint(df);
    expect(mountPoint).toBe("/System/Volumes/Data");
    const selected = selectMountEntry(entries.filter((entry) => entry !== null), mountPoint!);
    expect(selected?.type).toBe("apfs");
    expect(selected?.options).toContain("local");
    expect(assertSupportedLocalFilesystem(join(path, "flair-971-absent", "custody"))).toEqual({ ok: true, type: "apfs" });
  });
});

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
