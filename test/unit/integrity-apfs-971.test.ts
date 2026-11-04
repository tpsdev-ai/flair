/**
 * integrity-apfs-971.test.ts — flair#971 slice 1a.
 *
 * Runs custody initialization against a real APFS directory in the macOS CI
 * lane. macOS reports the same numeric `f_type` for local disk filesystems,
 * so the refusal must classify APFS by name.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { assertSupportedLocalFilesystem, classifyDarwinFilesystem, parseMountLine, selectMountEntry } from "../../src/lib/config-critical-section.ts";
import {
  commitGeneration,
  generationNumbers,
  initializeIntegrityCustody,
  integrityPaths,
} from "../../src/lib/integrity-state.ts";

const isDarwin = process.platform === "darwin";

// Fixed `mount` output lines; these tests run on every OS.
const ROOT_LINE = "/dev/disk3s1 on / (hfs, local, journaled)";
const APFS_LINE = "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)";
const SPACE_LINE = "/dev/disk4s1 on /Volumes/Data Disk (apfs, local, nodev, nosuid, journaled)";
const SMB_LINE = "//operator-a@host-a/share on /Volumes/team (smbfs, nodev, nosuid, mounted by operator-a)";
const APFS_NO_LOCAL_LINE = "/dev/disk6s1 on /Volumes/Net (apfs, noexec, nobrowse)";

function deviceProbe(target: string, device: number) {
  return (path: string): number => {
    if (path === target) return device;
    const devices: Record<string, number> = { "/": 1, "/System/Volumes/Data": 2, "/Volumes/Data Disk": 3 };
    if (!Object.hasOwn(devices, path)) throw new Error(`unexpected stat: ${path}`);
    return devices[path]!;
  };
}

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

  it("accepts an apfs local mount for a path beneath its mount point", () => {
    const support = classifyDarwinFilesystem("/System/Volumes/Data/custody", `${ROOT_LINE}\n${APFS_LINE}`, deviceProbe("/System/Volumes/Data/custody", 2));
    expect(support.ok).toBe(true);
    if (support.ok) expect(support.type).toBe("apfs");
  });

  it("refuses an smbfs mount", () => {
    const support = classifyDarwinFilesystem("/Volumes/team/custody", `${ROOT_LINE}\n${SMB_LINE}`, deviceProbe("/Volumes/team/custody", 4));
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("no recognized local mount");
  });

  it("selects a mount point that contains a space", () => {
    const entries = [parseMountLine(ROOT_LINE), parseMountLine(SPACE_LINE)];
    const parsed = entries.filter((entry) => entry !== null);
    const selected = selectMountEntry(parsed, "/Volumes/Data Disk/custody", deviceProbe("/Volumes/Data Disk/custody", 3));
    expect(selected?.mountPoint).toBe("/Volumes/Data Disk");
    const support = classifyDarwinFilesystem("/Volumes/Data Disk/custody", `${ROOT_LINE}\n${SPACE_LINE}`, deviceProbe("/Volumes/Data Disk/custody", 3));
    expect(support.ok).toBe(true);
  });

  it("matches the Data volume device instead of the root device", () => {
    const entries = [parseMountLine(ROOT_LINE), parseMountLine(APFS_LINE)].filter((entry) => entry !== null);
    const selected = selectMountEntry(entries, "/System/Volumes/Data/custody", deviceProbe("/System/Volumes/Data/custody", 2));
    expect(selected?.mountPoint).toBe("/System/Volumes/Data");
    const support = classifyDarwinFilesystem("/System/Volumes/Data/custody", `${ROOT_LINE}\n${APFS_LINE}`, deviceProbe("/System/Volumes/Data/custody", 2));
    expect(support.ok).toBe(true);
    if (support.ok) expect(support.type).toBe("apfs");
  });

  it("refuses unparseable mount output", () => {
    const support = classifyDarwinFilesystem("/System/Volumes/Data", "not a mount line");
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("unparseable mount entry");
  });

  it("refuses an apfs mount that is not local", () => {
    const support = classifyDarwinFilesystem("/Volumes/Net/custody", `${ROOT_LINE}\n${APFS_NO_LOCAL_LINE}`, deviceProbe("/Volumes/Net/custody", 5));
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("no recognized local mount");
  });

  it("refuses a nested nonlocal mount reached through Users without statting its mount point", () => {
    const target = "/Users/operator/team/custody";
    const table = `${ROOT_LINE}\n${APFS_LINE}\n//host/share on /System/Volumes/Data/Users/operator/team (smbfs, nosuid)`;
    const calls: string[] = [];
    const support = classifyDarwinFilesystem(target, table, (path) => {
      calls.push(path);
      return deviceProbe(target, 4)(path);
    });
    expect(support.ok).toBe(false);
    expect(calls).toEqual([target, "/", "/System/Volumes/Data"]);
  });

  it("refuses a failed or invalid device probe and a malformed entry beside a valid entry", () => {
    expect(classifyDarwinFilesystem("/Users/operator", ROOT_LINE, () => { throw new Error("stat failed"); }).ok).toBe(false);
    expect(classifyDarwinFilesystem("/Users/operator", ROOT_LINE, () => NaN).ok).toBe(false);
    expect(classifyDarwinFilesystem("/Users/operator", `${ROOT_LINE}\nunparseable`, () => 1).ok).toBe(false);
  });

  it.skipIf(!isDarwin)("matches the real home path to the Data volume mount", () => {
    const path = realpathSync(userInfo().homedir);
    const table = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000 });
    const entries = table.trim().split("\n").map(parseMountLine);
    expect(entries.every((entry) => entry !== null)).toBe(true);
    const selected = selectMountEntry(entries.filter((entry) => entry !== null), path);
    expect(selected?.mountPoint).toBe("/System/Volumes/Data");
    expect(statSync(path).dev).toBe(statSync("/System/Volumes/Data").dev);
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
