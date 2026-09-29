/**
 * service-repoint-2034.test.ts — flair#2034 §2: `flair init` re-points the
 * instance's OWN service unit at this CLI's install tree by replacing only its
 * runtime paths. Every other byte of the unit — including values that carry
 * XML escapes and settings the operator changed — must survive; anything not
 * in the shape flair writes is refused, never guessed.
 *
 * Pure: the planners take text and injected path facts. No filesystem.
 */
import { describe, test, expect } from "bun:test";
import {
  planPlistRuntimeRepoint,
  planSystemdUnitRuntimeRepoint,
  type PlistOwnership,
  type RepointDeps,
  type RepointTargets,
} from "../../src/lib/service-repoint.ts";
import { buildLaunchdPlist } from "../../src/cli.ts";

const OLD = "/Users/u/.local/share/mise/installs/node/24.18.0";
const NEW = "/Users/u/.local/share/mise/installs/node/24.19.0";
const OLD_TREE = `${OLD}/lib/node_modules/@tpsdev-ai/flair`;
const NEW_TREE = `${NEW}/lib/node_modules/@tpsdev-ai/flair`;
const NEW_ALIAS_NODE = "/Users/u/.local/share/mise/installs/node/24/bin/node";
const LAUNCHER = "templates/launchd/start-flair-with-admin-pass.sh";
const HARPER = "node_modules/harper/dist/bin/harper.js";

/** This instance, as the adopted plist below declares it. */
const OWNER: PlistOwnership = {
  label: "ai.tpsdev.flair.abcd1234",
  dataDir: "/Users/u/.flair/data",
  home: "/Users/u",
  adminPassFile: "/Users/u/.flair/admin-pass",
};

const targets: RepointTargets = {
  launcher: `${NEW_TREE}/${LAUNCHER}`,
  nodeBin: NEW_ALIAS_NODE,
  harperBin: `${NEW_TREE}/${HARPER}`,
  workingDirectory: NEW_TREE,
  cliVersion: "0.57.0",
};

function deps(over: Partial<RepointDeps> & { present?: string[]; versions?: Record<string, string> } = {}): RepointDeps {
  const present = new Set(over.present ?? [
    `${OLD}/bin/node`, `${OLD_TREE}/${LAUNCHER}`, `${OLD_TREE}/${HARPER}`, OLD_TREE,
    NEW_ALIAS_NODE, `${NEW_TREE}/${LAUNCHER}`, `${NEW_TREE}/${HARPER}`, NEW_TREE,
  ]);
  const versions = over.versions ?? { [OLD_TREE]: "0.57.0", [NEW_TREE]: "0.57.0" };
  return {
    exists: (p) => present.has(p),
    samePath: (a, b) => a.replace(/\/$/, "") === b.replace(/\/$/, ""),
    canonical: (p) => p,
    treeVersion: (d) => versions[d] ?? null,
    ...over,
  };
}

/** The plist `flair init` writes for the OLD runtime, with operator-visible values carrying `&`. */
function adoptedPlist(over: { tree?: string; node?: string; args?: string } = {}): string {
  const tree = over.tree ?? OLD_TREE;
  const text = buildLaunchdPlist({
    label: "ai.tpsdev.flair.abcd1234",
    execPath: over.node ?? `${OLD}/bin/node`,
    harperBinPath: `${tree}/${HARPER}`,
    workingDirectory: tree,
    dataDir: "/Users/u/.flair/data",
    modelsDir: "/Users/u/models & more",
    setConfig: JSON.stringify({ rootPath: "/Users/u/.flair/data", http: { port: 9926 } }),
    adminUser: "admin",
    httpPort: 9926,
    opsNetworkPort: "127.0.0.1:9925",
    passFile: {
      launcher: `${tree}/${LAUNCHER}`,
      adminPassFile: "/Users/u/.flair/admin-pass",
      home: "/Users/u",
      path: "/custom/bin:/Users/u/R&D/bin:/usr/bin:/bin",
    },
  });
  return over.args ? text.replace(/<array>[\s\S]*?<\/array>/, over.args) : text;
}

describe("planPlistRuntimeRepoint", () => {
  test("re-points exactly the four runtime values of an adopted pass-file plist", () => {
    const before = adoptedPlist();
    const plan = planPlistRuntimeRepoint(before, targets, deps(), "/p.plist", OWNER);
    expect(plan.kind).toBe("repoint");
    if (plan.kind !== "repoint") return;
    expect(plan.changes.map((c) => c.field)).toEqual(["launcher", "node", "Harper entry", "WorkingDirectory"]);
    // The re-pointed text is exactly the plist init would write for the new tree,
    // with the SAME operator/instance values everywhere else.
    const expected = buildLaunchdPlist({
      label: "ai.tpsdev.flair.abcd1234",
      execPath: NEW_ALIAS_NODE,
      harperBinPath: `${NEW_TREE}/${HARPER}`,
      workingDirectory: NEW_TREE,
      dataDir: "/Users/u/.flair/data",
      modelsDir: "/Users/u/models & more",
      setConfig: JSON.stringify({ rootPath: "/Users/u/.flair/data", http: { port: 9926 } }),
      adminUser: "admin",
      httpPort: 9926,
      opsNetworkPort: "127.0.0.1:9925",
      passFile: {
        launcher: `${NEW_TREE}/${LAUNCHER}`,
        adminPassFile: "/Users/u/.flair/admin-pass",
        home: "/Users/u",
        path: "/custom/bin:/Users/u/R&D/bin:/usr/bin:/bin",
      },
    });
    expect(plan.text).toBe(expected);
    // XML-escaped values are carried through untouched — never double-escaped.
    expect(plan.text).toContain("/Users/u/R&amp;D/bin");
    expect(plan.text).toContain("/Users/u/models &amp; more");
    expect(plan.text).not.toContain("&amp;amp;");
    expect(plan.text).toContain("<string>/Users/u/.flair/admin-pass</string>");
  });

  test("new values are XML-escaped, old values decoded before comparing", () => {
    const amp = { ...targets, workingDirectory: `${NEW}/lib/node_modules/@tpsdev-ai/flair` };
    const oldAmpTree = "/Users/u/A&B/lib/node_modules/@tpsdev-ai/flair";
    const before = adoptedPlist({ tree: oldAmpTree });
    expect(before).toContain("A&amp;B");
    const d = deps({
      present: [`${NEW_TREE}/${LAUNCHER}`, `${NEW_TREE}/${HARPER}`, NEW_TREE, NEW_ALIAS_NODE, `${oldAmpTree}/${LAUNCHER}`],
      versions: { [oldAmpTree]: "0.57.0" },
    });
    const plan = planPlistRuntimeRepoint(before, amp, d, "/p.plist", OWNER);
    expect(plan.kind).toBe("repoint");
    if (plan.kind === "repoint") {
      expect(plan.changes.find((c) => c.field === "WorkingDirectory")?.from).toBe(oldAmpTree);
      expect(plan.text).not.toContain("A&amp;B");
    }
  });

  test("already this CLI's tree: current, nothing to write", () => {
    const plan = planPlistRuntimeRepoint(adoptedPlist({ tree: NEW_TREE, node: NEW_ALIAS_NODE }), targets, deps(), "/p.plist", OWNER);
    expect(plan.kind).toBe("current");
  });

  test("this CLI's tree under a DIFFERENT existing node: a deliberate pin, left alone", () => {
    const pinned = "/opt/pinned/node/bin/node";
    const plan = planPlistRuntimeRepoint(
      adoptedPlist({ tree: NEW_TREE, node: pinned }),
      targets,
      deps({ present: [pinned, NEW_ALIAS_NODE, `${NEW_TREE}/${LAUNCHER}`, `${NEW_TREE}/${HARPER}`, NEW_TREE] }),
      "/p.plist",
      OWNER,
    );
    expect(plan.kind).toBe("pinned-node");
  });

  test("this CLI's tree with a node that no longer exists: only the node is replaced", () => {
    const gone = "/opt/gone/node/bin/node";
    const plan = planPlistRuntimeRepoint(adoptedPlist({ tree: NEW_TREE, node: gone }), targets, deps(), "/p.plist", OWNER);
    expect(plan.kind).toBe("repoint");
    if (plan.kind === "repoint") expect(plan.changes.map((c) => c.field)).toEqual(["node"]);
  });

  test("a plain tree or checkout is separately managed: refused", () => {
    const plan = planPlistRuntimeRepoint(adoptedPlist({ tree: "/Users/u/work/flair" }), targets, deps(), "/p.plist", OWNER);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.detail).toContain("separately managed");
  });

  test("an old tree with a NEWER flair than this CLI's: refused (no downgrade)", () => {
    const plan = planPlistRuntimeRepoint(adoptedPlist(), targets, deps({ versions: { [OLD_TREE]: "0.58.0" } }), "/p.plist", OWNER);
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.detail).toContain("downgrade");
  });

  test("not the four-argument launcher shape: refused", () => {
    const five = `<array>
    <string>${OLD_TREE}/${LAUNCHER}</string>
    <string>/Users/u/.flair/admin-pass</string>
    <string>${OLD}/bin/node</string>
    <string>${OLD_TREE}/${HARPER}</string>
    <string>--extra</string>
  </array>`;
    expect(planPlistRuntimeRepoint(adoptedPlist({ args: five }), targets, deps(), "/p.plist", OWNER).kind).toBe("refuse");
  });

  test("this CLI's tree is missing a file the unit would exec: refused", () => {
    const plan = planPlistRuntimeRepoint(adoptedPlist(), targets, deps({ present: [NEW_TREE, NEW_ALIAS_NODE] }), "/p.plist", OWNER);
    expect(plan.kind).toBe("refuse");
  });
});

describe("planSystemdUnitRuntimeRepoint (Linux)", () => {
  const LNX_OLD = "/home/u/.nvm/versions/node/v24.18.0";
  const LNX_NEW = "/home/u/.nvm/versions/node/v24.19.0";
  const LOLD = `${LNX_OLD}/lib/node_modules/@tpsdev-ai/flair`;
  const LNEW = `${LNX_NEW}/lib/node_modules/@tpsdev-ai/flair`;
  const t: RepointTargets = {
    launcher: `${LNEW}/${LAUNCHER}`,
    nodeBin: `${LNX_NEW}/bin/node`,
    harperBin: `${LNEW}/${HARPER}`,
    workingDirectory: LNEW,
    cliVersion: "0.57.0",
  };
  const d = deps({
    present: [`${LNX_NEW}/bin/node`, `${LNEW}/${HARPER}`, LNEW, `${LNEW}/${LAUNCHER}`],
    versions: { [LOLD]: "0.57.0" },
  });
  const unit = [
    "[Unit]",
    "Description=Flair (operator-written)",
    "",
    "[Service]",
    "# the operator's own comments stay",
    `WorkingDirectory=${LOLD}`,
    `ExecStart=${LNX_OLD}/bin/node   ${LOLD}/${HARPER} run .`,
    "Environment=PATH=/custom/bin:/usr/bin",
    "Environment=ROOTPATH=/home/u/.flair/data",
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  test("rewrites WorkingDirectory and the ExecStart runtime paths, and nothing else", () => {
    const plan = planSystemdUnitRuntimeRepoint(unit, LOLD, t, d, "/u.service");
    expect(plan.kind).toBe("repoint");
    if (plan.kind !== "repoint") return;
    const before = unit.split("\n");
    const after = plan.text.split("\n");
    expect(after.length).toBe(before.length);
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([5, 6]);
    expect(after[5]).toBe(`WorkingDirectory=${LNEW}`);
    // Spacing between words is preserved.
    expect(after[6]).toBe(`ExecStart=${LNX_NEW}/bin/node   ${LNEW}/${HARPER} run .`);
  });

  test("a launcher-in-tree ExecStart maps to the same file in the new tree", () => {
    const u = unit.replace(/^ExecStart=.*$/m, `ExecStart=-${LOLD}/${LAUNCHER} /home/u/.flair/admin-pass ${LNX_OLD}/bin/node ${LOLD}/${HARPER}`);
    const plan = planSystemdUnitRuntimeRepoint(u, LOLD, t, d, "/u.service");
    expect(plan.kind).toBe("repoint");
    if (plan.kind === "repoint") {
      expect(plan.text).toContain(`ExecStart=-${LNEW}/${LAUNCHER} /home/u/.flair/admin-pass ${LNX_NEW}/bin/node ${LNEW}/${HARPER}`);
    }
  });

  for (const [name, mutate] of [
    ["a line continuation", (u: string) => u.replace(" run .", " \\\n  run .")],
    ["two ExecStart= lines", (u: string) => u.replace("Restart=always", `ExecStart=${LNX_OLD}/bin/node other.js\nRestart=always`)],
    ["a quoted word", (u: string) => u.replace(`${LOLD}/${HARPER}`, `"${LOLD}/${HARPER}"`)],
    ["a specifier", (u: string) => u.replace(" run .", " run %h")],
    ["an environment variable", (u: string) => u.replace(" run .", " run $DIR")],
    ["an opaque wrapper executable", (u: string) => u.replace(`${LNX_OLD}/bin/node`, "/usr/local/bin/start-flair")],
    ["a WorkingDirectory that is not the serving tree", (u: string) => u.replace(`WorkingDirectory=${LOLD}`, "WorkingDirectory=/srv")],
  ] as const) {
    test(`refused, never guessed: ${name}`, () => {
      expect(planSystemdUnitRuntimeRepoint(mutate(unit), LOLD, t, d, "/u.service").kind).toBe("refuse");
    });
  }

  test("an ExecStart file with no counterpart in the new tree: refused", () => {
    const u = unit.replace(" run .", ` ${LOLD}/only-in-old.js`);
    expect(planSystemdUnitRuntimeRepoint(u, LOLD, t, d, "/u.service").kind).toBe("refuse");
  });

  test("already this CLI's tree: current", () => {
    const current = unit.split(LOLD).join(LNEW).split(`${LNX_OLD}/bin/node`).join(`${LNX_NEW}/bin/node`);
    expect(planSystemdUnitRuntimeRepoint(current, LNEW, t, d, "/u.service").kind).toBe("current");
  });
});
