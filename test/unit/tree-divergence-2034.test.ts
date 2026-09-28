/**
 * tree-divergence-2034.test.ts — flair#2034 §2 item 1.
 *
 * The CLI's package dir vs the running instance's install tree, read from the
 * launchd plist / systemd unit, and the ONE message that names actor, state and
 * remedy.
 */
import { describe, test, expect } from "bun:test";
import {
  computeTreeDivergence,
  formatTreeDivergenceLines,
  formatTreeDivergenceOneLine,
  readInstanceRuntime,
  readPlistInstanceRuntime,
  readSystemdInstanceRuntime,
} from "../../src/lib/tree-divergence.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/old/tree/templates/launchd/start-flair-with-admin-pass.sh</string>
    <string>/home/u/.flair/admin.pass</string>
    <string>/opt/old/node/bin/node</string>
    <string>/opt/old/tree/node_modules/harper/dist/bin/harper.js</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/old/tree</string>
</dict></plist>`;

const UNIT = `[Service]
Type=simple
ExecStart=/opt/old/tree/templates/launchd/start-flair-with-admin-pass.sh /home/u/.flair/admin.pass /opt/old/node/bin/node /opt/old/tree/node_modules/harper/dist/bin/harper.js
WorkingDirectory=/opt/old/tree
`;

describe("readInstanceRuntime", () => {
  test("macOS: node binary and install tree come out of the plist", () => {
    const refs = readPlistInstanceRuntime("/x.plist", { read: () => PLIST });
    expect(refs.nodeBin).toBe("/opt/old/node/bin/node");
    expect(refs.workingDirectory).toBe("/opt/old/tree");
  });

  test("linux: node binary and install tree come out of the systemd unit", () => {
    const refs = readSystemdInstanceRuntime("/x.service", { read: () => UNIT });
    expect(refs.nodeBin).toBe("/opt/old/node/bin/node");
    expect(refs.workingDirectory).toBe("/opt/old/tree");
  });

  test("platform selects the source", () => {
    const darwin = readInstanceRuntime({ platform: "darwin", plistPath: "/x.plist", deps: { read: () => PLIST } });
    expect(darwin.workingDirectory).toBe("/opt/old/tree");
    const linux = readInstanceRuntime({ platform: "linux", systemdUnitPath: "/x.service", deps: { read: () => UNIT } });
    expect(linux.workingDirectory).toBe("/opt/old/tree");
    const none = readInstanceRuntime({ platform: "darwin", plistPath: null });
    expect(none).toEqual({ nodeBin: null, workingDirectory: null });
  });
});

describe("computeTreeDivergence", () => {
  test("different trees diverge", () => {
    const d = computeTreeDivergence({ cliDir: "/opt/new/tree", cliVersion: "0.57.0", runningDir: "/opt/old/tree", runningVersion: "0.55.2" });
    expect(d.diverged).toBe(true);
    expect(d.runningDir).toBe("/opt/old/tree");
  });

  test("the same tree does not diverge", () => {
    const d = computeTreeDivergence({ cliDir: "/opt/tree", cliVersion: "0.57.0", runningDir: "/opt/tree", runningVersion: "0.57.0" });
    expect(d.diverged).toBe(false);
  });

  test("an unresolvable running tree is not a divergence", () => {
    const d = computeTreeDivergence({ cliDir: "/opt/tree", cliVersion: "0.57.0", runningDir: null });
    expect(d.diverged).toBe(false);
  });

  test("a CLI tree older than the running tree is marked", () => {
    const d = computeTreeDivergence({ cliDir: "/opt/new", cliVersion: "0.55.2", runningDir: "/opt/old", runningVersion: "0.57.0" });
    expect(d.cliTreeOlder).toBe(true);
  });
});

describe("formatTreeDivergenceLines", () => {
  const d = computeTreeDivergence({ cliDir: "/opt/new/tree", cliVersion: "0.55.2", runningDir: "/opt/old/tree", runningVersion: "0.57.0" });

  test("names both paths, both versions and the remedy", () => {
    const text = formatTreeDivergenceLines(d).join("\n");
    expect(text).toContain("/opt/new/tree");
    expect(text).toContain("/opt/old/tree");
    expect(text).toContain("0.55.2");
    expect(text).toContain("0.57.0");
    expect(text).toContain("flair init && flair restart");
  });

  test("names the upgrade step only when the CLI tree is the stale one", () => {
    expect(formatTreeDivergenceLines(d).join("\n")).toContain("npm i -g @tpsdev-ai/flair");
    const opposite = computeTreeDivergence({ cliDir: "/opt/new/tree", cliVersion: "0.57.0", runningDir: "/opt/old/tree", runningVersion: "0.55.2" });
    expect(formatTreeDivergenceLines(opposite).join("\n")).not.toContain("npm i -g @tpsdev-ai/flair");
  });

  test("no lines when the trees agree", () => {
    const same = computeTreeDivergence({ cliDir: "/opt/tree", cliVersion: "0.57.0", runningDir: "/opt/tree" });
    expect(formatTreeDivergenceLines(same)).toEqual([]);
    expect(formatTreeDivergenceOneLine(same)).toBeNull();
  });

  test("the one-line form names both trees", () => {
    const line = formatTreeDivergenceOneLine(d)!;
    expect(line).toContain("/opt/new/tree");
    expect(line).toContain("/opt/old/tree");
  });
});
