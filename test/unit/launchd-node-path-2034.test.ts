/**
 * launchd-node-path-2034.test.ts — flair#2034 §2.
 *
 * A plist whose node path is not the runtime this CLI runs under is classified,
 * not merely flagged: a different EXISTING node serving this CLI's own install
 * tree is a deliberate pin (reported, never rewritten); a unit serving another
 * tree is the erroneous node-bump divergence (re-pointed by flair init). This
 * holds even while the old tree still exists — `diagnoseLaunchdPlistPaths`
 * only fires once it is deleted.
 */
import { describe, test, expect } from "bun:test";
import { classifyServiceNodePin, diagnoseLaunchdNodePath } from "../../src/lib/launchd-management.ts";

const OLD_TREE = "/u/.local/share/mise/installs/node/24.18.0/lib/node_modules/@tpsdev-ai/flair";
const NEW_TREE = "/u/.local/share/mise/installs/node/24.19.0/lib/node_modules/@tpsdev-ai/flair";

function plistWith(node: string, tree = OLD_TREE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>${tree}/templates/launchd/start-flair-with-admin-pass.sh</string>
    <string>/u/.flair/admin-pass</string>
    <string>${node}</string>
    <string>${tree}/node_modules/harper/dist/bin/harper.js</string>
  </array>
  <key>WorkingDirectory</key><string>${tree}</string>
</dict></plist>`;
}

const identity = (p: string) => p;

describe("diagnoseLaunchdNodePath", () => {
  test("a different EXISTING runtime serving another tree is erroneous — even though the old tree still exists", () => {
    const m = diagnoseLaunchdNodePath("/x.plist", "/opt/new/node/bin/node", NEW_TREE, {
      read: () => plistWith("/opt/old/node/bin/node"),
      exists: () => true,
      realpath: identity,
    });
    expect(m?.kind).toBe("erroneous");
    expect(m!.unitNodeBin).toBe("/opt/old/node/bin/node");
    expect(m!.message).toContain(OLD_TREE);
    expect(m!.remedy).toEqual(["flair init", "flair restart"]);
  });

  test("a different existing runtime serving THIS CLI's tree is a deliberate pin: reported, no remedy", () => {
    const m = diagnoseLaunchdNodePath("/x.plist", "/opt/new/node/bin/node", NEW_TREE, {
      read: () => plistWith("/opt/pinned/node/bin/node", NEW_TREE),
      exists: () => true,
      realpath: identity,
    });
    expect(m?.kind).toBe("pinned");
    expect(m!.remedy).toEqual([]);
    expect(m!.message).toContain("deliberate runtime pin");
  });

  test("a version-manager alias resolving to the SAME runtime is no pin at all", () => {
    const m = diagnoseLaunchdNodePath("/x.plist", "/u/.local/share/mise/installs/node/24.19.0/bin/node", NEW_TREE, {
      read: () => plistWith("/u/.local/share/mise/installs/node/24/bin/node"),
      exists: () => true,
      realpath: () => "/u/.local/share/mise/installs/node/24.19.0/bin/node",
    });
    expect(m).toBeNull();
  });

  test("a MISSING pinned path is left to the missing-path diagnosis", () => {
    const m = diagnoseLaunchdNodePath("/x.plist", "/opt/new/node/bin/node", NEW_TREE, {
      read: () => plistWith("/opt/gone/node/bin/node"),
      exists: (p) => p !== "/opt/gone/node/bin/node",
      realpath: identity,
    });
    expect(m).toBeNull();
  });

  test("a plist with no node argument is not judged", () => {
    const read = () => `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/echo</string></array></dict></plist>`;
    expect(diagnoseLaunchdNodePath("/x.plist", "/opt/new/node", NEW_TREE, { read, exists: () => true, realpath: identity })).toBeNull();
  });
});

describe("classifyServiceNodePin (systemd units use the same rule)", () => {
  test("no working directory: not ours to judge", () => {
    expect(
      classifyServiceNodePin(
        { unitDescription: "u", unitNodeBin: "/a/node", unitTree: null, currentNodeBin: "/b/node", cliTree: NEW_TREE },
        { exists: () => true, realpath: identity },
      ),
    ).toBeNull();
  });
});
