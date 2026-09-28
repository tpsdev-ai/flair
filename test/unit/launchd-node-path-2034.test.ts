/**
 * launchd-node-path-2034.test.ts — flair#2034 §2 item 3.
 *
 * `diagnoseLaunchdPlistPaths` only fires once the pinned path is DELETED. A
 * node minor bump that leaves the old tree in place is the common divergence,
 * so the plist must be flagged by comparing node paths by realpath.
 */
import { describe, test, expect } from "bun:test";
import { diagnoseLaunchdNodePath } from "../../src/lib/launchd-management.ts";

function plistWith(node: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/tree/templates/launchd/start-flair-with-admin-pass.sh</string>
    <string>/home/u/.flair/admin.pass</string>
    <string>${node}</string>
    <string>/opt/tree/node_modules/harper/dist/bin/harper.js</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/tree</string>
</dict></plist>`;
}

describe("diagnoseLaunchdNodePath", () => {
  test("flags a plist whose node path is a DIFFERENT existing runtime", () => {
    const read = () => plistWith("/opt/old/node/bin/node");
    const m = diagnoseLaunchdNodePath("/x.plist", "/opt/new/node/bin/node", {
      read,
      exists: () => true,
      realpath: (p) => p,
    });
    expect(m).not.toBeNull();
    expect(m!.plistNodeBin).toBe("/opt/old/node/bin/node");
    expect(m!.currentNodeBin).toBe("/opt/new/node/bin/node");
    expect(m!.message).toContain("/opt/old/node/bin/node");
    expect(m!.remedy).toContain("flair init");
  });

  test("a version-manager alias resolving to the SAME runtime is not flagged", () => {
    const read = () => plistWith("/home/u/.local/share/mise/installs/node/24/bin/node");
    const m = diagnoseLaunchdNodePath("/x.plist", "/home/u/.local/share/mise/installs/node/24.19.0/bin/node", {
      read,
      exists: () => true,
      realpath: () => "/home/u/.local/share/mise/installs/node/24.19.0/bin/node",
    });
    expect(m).toBeNull();
  });

  test("a MISSING pinned path is left to the other diagnosis", () => {
    const read = () => plistWith("/opt/gone/node/bin/node");
    const m = diagnoseLaunchdNodePath("/x.plist", "/opt/new/node/bin/node", {
      read,
      exists: (p) => p !== "/opt/gone/node/bin/node",
      realpath: (p) => p,
    });
    expect(m).toBeNull();
  });

  test("a plist with no node argument is not judged", () => {
    const read = () => `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/echo</string></array></dict></plist>`;
    expect(diagnoseLaunchdNodePath("/x.plist", "/opt/new/node", { read, exists: () => true, realpath: (p) => p })).toBeNull();
  });
});
