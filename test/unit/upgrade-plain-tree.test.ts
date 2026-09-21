/**
 * upgrade-plain-tree.test.ts — flair#1109 (a)
 *
 * In-place tarball-swap / plain-tree upgrade lane. Detection, planning,
 * launcher preserve, rename-swap + rollback, systemd unit discovery.
 * Filesystem fixtures in a per-test temp dir; apply() is driven with an
 * injected exec so nothing hits the network.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
  realpathSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { create as tarCreate } from "tar";
import {
  inspectFlairTree,
  resolvePlainTreeTarget,
  listPreservedLauncherNames,
  planPlainTreeUpgrade,
  formatPlainTreeBanner,
  formatPlainTreeScopeFooter,
  formatPlainTreePlan,
  unitTextMentionsTree,
  findSystemdUnitsForTree,
  systemdRestartArgs,
  applyPlainTreeUpgrade,
  restorePlainTreePrevious,
  discardPlainTreePrevious,
  resolvePlainTreeListingTarget,
  decidePlainTreeRollback,
  treeSibling,
  PACKED_ROOT_NAMES,
  UPGRADE_NEXT_SUFFIX,
  UPGRADE_PREV_SUFFIX,
  isNpmGlobalTree,
  isSymlink,
  type TreeInspection,
  type ExecFile,
} from "../../src/lib/upgrade-plain-tree.js";
import type { FlairPackageLocation } from "../../src/lib/upgrade-exec-path.js";

function freshTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "flair-plain-tree-")));
}

function writeFlairTree(
  dir: string,
  opts: {
    version?: string;
    name?: string;
    git?: boolean;
    srcCli?: boolean;
    distCli?: boolean;
    extras?: Record<string, string>;
  } = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: opts.name ?? "@tpsdev-ai/flair", version: opts.version ?? "0.36.0" }),
  );
  if (opts.distCli !== false && opts.name !== "not-flair") {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  }
  if (opts.git) {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  if (opts.srcCli) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "cli.ts"), "export {}\n");
  }
  for (const [name, body] of Object.entries(opts.extras ?? {})) {
    const dest = join(dir, name);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body);
  }
}

describe("inspectFlairTree", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("packed extract is a plain-tree", () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, { version: "0.36.0" });
    expect(inspectFlairTree(tree)).toEqual({
      kind: "plain-tree",
      dir: realpathSync(tree),
      version: "0.36.0",
    });
  });

  test("git checkout is refused", () => {
    const tree = join(tmp, "checkout");
    writeFlairTree(tree, { version: "0.40.0", git: true });
    expect(inspectFlairTree(tree).kind).toBe("git-checkout");
  });

  test("copied source tree (src/cli.ts, no .git) is refused", () => {
    const tree = join(tmp, "src-copy");
    writeFlairTree(tree, { srcCli: true });
    expect(inspectFlairTree(tree).kind).toBe("source-tree");
  });

  test("wrong package name is not-flair", () => {
    const tree = join(tmp, "other");
    writeFlairTree(tree, { name: "@tpsdev-ai/flair-mcp" });
    expect(inspectFlairTree(tree).kind).toBe("not-flair");
  });

  test("flair package without dist/cli.js is not a packed tree", () => {
    const tree = join(tmp, "broken");
    writeFlairTree(tree, { distCli: false });
    expect(inspectFlairTree(tree).kind).toBe("not-flair");
  });
});

describe("resolvePlainTreeTarget", () => {
  const spoke: FlairPackageLocation = { dir: "/opt/flair-spoke", version: "0.36.0" };
  const global: FlairPackageLocation = {
    dir: "/home/u/.npm-global/lib/node_modules/@tpsdev-ai/flair",
    version: "0.28.0",
  };
  const inspect = (dir: string): TreeInspection => {
    if (dir === spoke.dir) return { kind: "plain-tree", dir, version: "0.36.0" };
    if (dir === global.dir) return { kind: "plain-tree", dir, version: "0.28.0" };
    if (dir === "/repo") return { kind: "git-checkout", dir, version: "0.50.0" };
    if (dir === "/src-copy") return { kind: "source-tree", dir, version: "0.50.0" };
    return { kind: "not-flair", dir, version: null };
  };

  test("the incident: serving packed tree wins over a stale npm-global CLI", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: null,
      serving: spoke,
      cli: global,
      global,
      inspect,
    });
    expect(decision.kind).toBe("use");
    if (decision.kind !== "use") return;
    expect(decision.inspection.dir).toBe(spoke.dir);
    expect(decision.inspection.version).toBe("0.36.0");
  });

  test("no serving pid: this CLI is a packed tree and not npm-global", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: null,
      serving: null,
      cli: spoke,
      global,
      inspect,
    });
    expect(decision.kind).toBe("use");
    if (decision.kind !== "use") return;
    expect(decision.inspection.dir).toBe(spoke.dir);
  });

  test("npm-global serving tree is skip — that is the existing lane", () => {
    expect(resolvePlainTreeTarget({
      treeFlag: null,
      serving: global,
      cli: global,
      global,
      inspect,
    }).kind).toBe("skip");
  });

  test("git checkout serving tree is skip (do not tarball-swap a checkout)", () => {
    expect(resolvePlainTreeTarget({
      treeFlag: null,
      serving: { dir: "/repo", version: "0.50.0" },
      cli: { dir: "/repo", version: "0.50.0" },
      global,
      inspect,
    }).kind).toBe("skip");
  });

  test("--tree on a packed install is use even if serving differs", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: spoke.dir,
      serving: null,
      cli: global,
      global,
      inspect,
    });
    expect(decision.kind).toBe("use");
  });

  test("--tree on the npm-global path refuses", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: global.dir,
      serving: null,
      cli: global,
      global,
      inspect,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.message).toContain("npm-global");
    expect(decision.message).toContain("Omit --tree");
  });

  test("--tree on a git checkout refuses", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: "/repo",
      serving: null,
      cli: null,
      global: null,
      inspect,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.message).toContain("git checkout");
  });

  test("--tree on a source tree refuses", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: "/src-copy",
      serving: null,
      cli: null,
      global: null,
      inspect,
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.message).toContain("source tree");
  });

  test("--tree on a missing path refuses", () => {
    const decision = resolvePlainTreeTarget({
      treeFlag: "/no/such/tree",
      serving: null,
      cli: null,
      global: null,
      inspect,
    });
    expect(decision.kind).toBe("refuse");
  });
});

describe("listPreservedLauncherNames", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("keeps operator launcher and .env, drops packed names and node_modules", () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, {
      extras: {
        flair: "#!/bin/sh\nexec node dist/cli.js \"$@\"\n",
        ".env": "FLAIR_PUBLIC_URL=https://spoke.example\n",
      },
    });
    mkdirSync(join(tree, "node_modules"), { recursive: true });
    writeFileSync(join(tree, "config.yaml"), "http:\n  port: 19926\n");
    writeFileSync(join(tree, "README.md"), "# flair\n");
    const names = listPreservedLauncherNames(tree);
    expect(names).toEqual([".env", "flair"]);
    for (const packed of PACKED_ROOT_NAMES) {
      expect(names).not.toContain(packed);
    }
  });
});

describe("plan + wording", () => {
  test("plan uses sibling staging/previous paths", () => {
    const plan = planPlainTreeUpgrade({
      treeDir: "/opt/flair-spoke",
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
      preserve: ["flair", ".env"],
      systemdUnits: [{ name: "flair.service", path: "/etc/systemd/system/flair.service", scope: "system" }],
    });
    expect(plan.stagingDir).toBe(treeSibling("/opt/flair-spoke", UPGRADE_NEXT_SUFFIX));
    expect(plan.previousDir).toBe(treeSibling("/opt/flair-spoke", UPGRADE_PREV_SUFFIX));
    expect(plan.preserve).toEqual(["flair", ".env"]);
  });

  test("banner and footer name the tree and the lane, not npm-global as the install", () => {
    const inspection: TreeInspection = {
      kind: "plain-tree",
      dir: "/opt/flair-spoke",
      version: "0.36.0",
    };
    const banner = formatPlainTreeBanner(inspection);
    expect(banner).toContain("Plain-tree install: /opt/flair-spoke  (0.36.0)");
    expect(banner).toContain("swap this tree in place");
    expect(banner.toLowerCase()).not.toContain("only upgrades the npm-global");

    const footer = formatPlainTreeScopeFooter(inspection);
    expect(footer).toContain("plain-tree at /opt/flair-spoke");
    expect(footer).toContain("fetch tarball, swap, preserve launcher, restart unit");
    expect(footer).toContain("npm-global packages are not this instance's install");
  });

  test("check plan lists preserve + unit restart", () => {
    const text = formatPlainTreePlan(planPlainTreeUpgrade({
      treeDir: "/opt/flair-spoke",
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
      preserve: ["flair"],
      systemdUnits: [{ name: "flair.service", path: "/etc/systemd/system/flair.service", scope: "system" }],
    }));
    expect(text).toContain("@tpsdev-ai/flair: 0.36.0 → 0.50.0  (in-place tarball swap)");
    expect(text).toContain("preserve launcher/overlay: flair");
    expect(text).toContain("restart unit: flair.service (system:");
  });

  test("check plan says flair restart when no unit is found", () => {
    const text = formatPlainTreePlan(planPlainTreeUpgrade({
      treeDir: "/opt/flair-spoke",
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
      preserve: [],
    }));
    expect(text).toContain("no systemd unit found");
    expect(text).toContain("`flair restart`");
  });
});

describe("systemd unit discovery", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("unitTextMentionsTree matches WorkingDirectory and ExecStart", () => {
    const unit = [
      "[Service]",
      "WorkingDirectory=/opt/flair-spoke",
      "ExecStart=/usr/bin/node /opt/flair-spoke/node_modules/harper/bin/harper run .",
    ].join("\n");
    expect(unitTextMentionsTree(unit, "/opt/flair-spoke")).toBe(true);
    expect(unitTextMentionsTree(unit, "/opt/other")).toBe(false);
  });

  test("unitTextMentionsTree does not match an unanchored prefix sibling", () => {
    const spoke = [
      "[Service]",
      "WorkingDirectory=/opt/flair-spoke",
      "ExecStart=/opt/flair-spoke/flair start",
    ].join("\n");
    expect(unitTextMentionsTree(spoke, "/opt/flair")).toBe(false);
    expect(unitTextMentionsTree(spoke, "/opt/flair-spoke")).toBe(true);

    const exact = "[Service]\nWorkingDirectory=/opt/flair\nExecStart=/opt/flair/flair start\n";
    expect(unitTextMentionsTree(exact, "/opt/flair")).toBe(true);
    expect(unitTextMentionsTree(exact, "/opt/flair-spoke")).toBe(false);
  });

  test("findSystemdUnitsForTree does not select a sibling whose path only shares a prefix", () => {
    const systemDir = join(tmp, "system-prefix");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(
      join(systemDir, "flair.service"),
      "[Service]\nWorkingDirectory=/opt/flair\nExecStart=/opt/flair/flair start\n",
    );
    writeFileSync(
      join(systemDir, "spoke.service"),
      "[Service]\nWorkingDirectory=/opt/flair-spoke\nExecStart=/opt/flair-spoke/flair start\n",
    );
    const forShort = findSystemdUnitsForTree("/opt/flair", {
      systemDirs: [systemDir],
      userDir: join(tmp, "user-empty"),
      envUnit: "",
    });
    expect(forShort.map((u) => u.name)).toEqual(["flair.service"]);
    const forSpoke = findSystemdUnitsForTree("/opt/flair-spoke", {
      systemDirs: [systemDir],
      userDir: join(tmp, "user-empty"),
      envUnit: "",
    });
    expect(forSpoke.map((u) => u.name)).toEqual(["spoke.service"]);
  });

  test("discovers a unit naming a symlinked tree after target resolution canonicalizes either --tree spelling", () => {
    // The fixture ROOT stays canonical and the mismatch is created
    // deliberately beneath it (#1754 canonicalized the CI lane's fixture, so
    // that lane can no longer build this shape — the coverage lives here).
    //
    // The product canonicalizes the tree before matching anything
    // (readFlairPackageAt → canonicalPath) and discovery is called with that
    // canonical dir, while the unit on disk holds whatever the operator wrote.
    const realTree = join(tmp, "srv", "flair");
    writeFlairTree(realTree, { version: "0.36.0" });
    const aliasTree = join(tmp, "opt", "flair");
    mkdirSync(dirname(aliasTree), { recursive: true });
    symlinkSync(realTree, aliasTree, "dir");
    const canonicalReal = realpathSync(realTree);

    const userDir = join(tmp, "user-empty");

    // One unit naming the ALIAS spelling via BOTH directives.
    const bothDir = join(tmp, "units-both");
    mkdirSync(bothDir, { recursive: true });
    writeFileSync(
      join(bothDir, "alias.service"),
      ["[Service]", `WorkingDirectory=${aliasTree}`, `ExecStart=${aliasTree}/flair start`].join("\n"),
    );
    // WorkingDirectory ALONE, so a WorkingDirectory-only matcher is exercised.
    const wdDir = join(tmp, "units-wd");
    mkdirSync(wdDir, { recursive: true });
    writeFileSync(
      join(wdDir, "wd.service"),
      ["[Service]", `WorkingDirectory=${aliasTree}`].join("\n"),
    );
    // ExecStart ALONE, so an ExecStart-only matcher is exercised.
    const execDir = join(tmp, "units-exec");
    mkdirSync(execDir, { recursive: true });
    writeFileSync(
      join(execDir, "exec.service"),
      ["[Service]", `ExecStart=${aliasTree}/flair start`].join("\n"),
    );

    const discover = (dir: string, treeDir: string) =>
      findSystemdUnitsForTree(treeDir, { systemDirs: [dir], userDir, envUnit: "" });

    // For BOTH the alias and the real --tree spelling, target resolution yields
    // the same canonical dir — the dir discovery is actually handed.
    for (const spelling of [aliasTree, realTree]) {
      const target = resolvePlainTreeTarget({
        treeFlag: spelling,
        serving: null,
        cli: null,
        global: null,
      });
      expect(target.kind).toBe("use");
      if (target.kind !== "use") return;
      expect(target.inspection.dir).toBe(canonicalReal);

      expect(discover(bothDir, target.inspection.dir)).toEqual([
        { name: "alias.service", path: join(bothDir, "alias.service"), scope: "system" },
      ]);
      expect(discover(wdDir, target.inspection.dir).map((u) => u.name)).toEqual(["wd.service"]);
      expect(discover(execDir, target.inspection.dir).map((u) => u.name)).toEqual(["exec.service"]);
    }

    // Properly QUOTED operands are handled (systemd quoting, not a blind split).
    const quotedDir = join(tmp, "units-quoted");
    mkdirSync(quotedDir, { recursive: true });
    writeFileSync(
      join(quotedDir, "q.service"),
      ["[Service]", `WorkingDirectory="${aliasTree}"`, `ExecStart="${aliasTree}/flair" start`].join("\n"),
    );
    expect(discover(quotedDir, canonicalReal).map((u) => u.name)).toEqual(["q.service"]);

    // RETARGET: point the alias at another packed tree. Fresh discovery must
    // match the NEW target and reject the old one.
    const realTree2 = join(tmp, "srv2", "flair");
    writeFlairTree(realTree2, { version: "0.40.0" });
    unlinkSync(aliasTree);
    symlinkSync(realTree2, aliasTree, "dir");
    const canonicalReal2 = realpathSync(realTree2);

    expect(discover(bothDir, canonicalReal2)).toEqual([
      { name: "alias.service", path: join(bothDir, "alias.service"), scope: "system" },
    ]);
    expect(discover(bothDir, canonicalReal)).toEqual([]);

    // NEGATIVE — the false-positive half: discovery must NOT select on text that
    // merely contains the tree path.
    const negDir = join(tmp, "units-neg");
    mkdirSync(negDir, { recursive: true });
    // the canonical path inside a COMMENT
    writeFileSync(
      join(negDir, "comment.service"),
      ["[Service]", `# WorkingDirectory=${canonicalReal2}`, `# ExecStart=${canonicalReal2}/flair start`].join("\n"),
    );
    // an unrelated pathname that merely CONTAINS the tree path
    writeFileSync(
      join(negDir, "sibling.service"),
      ["[Service]", `WorkingDirectory=${canonicalReal2}-spoke`, `ExecStart=${canonicalReal2}-spoke/flair start`].join("\n"),
    );
    // quoted paths that are NOT path operands: a shell string and an env value
    writeFileSync(
      join(negDir, "quoted.service"),
      [
        "[Service]",
        `ExecStart=/bin/sh -c "cd ${canonicalReal2} && ./flair start"`,
        `Environment="FLAIR_HOME=${canonicalReal2}"`,
      ].join("\n"),
    );
    expect(discover(negDir, canonicalReal2)).toEqual([]);
  });

  test("reset semantics: a blank assignment clears collected operands (flair#1758 follow-up)", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);
    const other = join(tmp, "elsewhere");
    mkdirSync(other, { recursive: true });

    // systemd: `Key=` with a blank value RESETS the list for that key.
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${canonicalTree}`, "WorkingDirectory="].join("\n"),
      canonicalTree,
    )).toBe(false);
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${canonicalTree}/flair start`, "ExecStart="].join("\n"),
      canonicalTree,
    )).toBe(false);

    // reset with no prior value: no match, no crash.
    expect(unitTextMentionsTree("[Service]\nWorkingDirectory=\n", canonicalTree)).toBe(false);
    expect(unitTextMentionsTree("[Service]\nExecStart=\n", canonicalTree)).toBe(false);

    // set, reset, set-again: only the LAST value counts.
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${canonicalTree}`, "WorkingDirectory=", `WorkingDirectory=${other}`].join("\n"),
      canonicalTree,
    )).toBe(false); // the pre-reset tree value was cleared
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${other}`, "WorkingDirectory=", `WorkingDirectory=${canonicalTree}`].join("\n"),
      canonicalTree,
    )).toBe(true); // the last value is the tree
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${canonicalTree}/flair start`, "ExecStart=", `ExecStart=${other}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(false);
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${other}/flair start`, "ExecStart=", `ExecStart=${canonicalTree}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(true);
  });

  test("folds systemd line continuations before parsing operands", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);

    // The value lands on the CONTINUATION line, so without folding the
    // declaration would be read as an empty (reset) assignment.
    expect(unitTextMentionsTree(
      ["[Service]", "WorkingDirectory=\\", canonicalTree].join("\n"),
      canonicalTree,
    )).toBe(true);
    expect(unitTextMentionsTree(
      ["[Service]", "ExecStart=\\", `${canonicalTree}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(true);

    // Also the shape where the executable is complete but the command continues.
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${canonicalTree}/flair \\`, "  start --port 9926"].join("\n"),
      canonicalTree,
    )).toBe(true);
  });

  test("duplicated directives: WorkingDirectory is single-valued (last wins), ExecStart accumulates", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);
    const other = join(tmp, "elsewhere");
    mkdirSync(other, { recursive: true });

    // WorkingDirectory: systemd keeps the LAST non-blank assignment only
    // (config_parse_working_directory = free_and_replace).
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${canonicalTree}`, `WorkingDirectory=${other}`].join("\n"),
      canonicalTree,
    )).toBe(false); // active value is <other>, NOT the tree
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${other}`, `WorkingDirectory=${canonicalTree}`].join("\n"),
      canonicalTree,
    )).toBe(true); // active value is the tree

    // ExecStart: a genuine LIST — every non-blank assignment is an operand,
    // in either order.
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${other}/flair start`, `ExecStart=${canonicalTree}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(true);
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${canonicalTree}/flair start`, `ExecStart=${other}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(true);

    // reset + re-set ordering still holds for the single-valued key.
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${canonicalTree}`, "WorkingDirectory=", `WorkingDirectory=${other}`].join("\n"),
      canonicalTree,
    )).toBe(false);
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${other}`, "WorkingDirectory=", `WorkingDirectory=${canonicalTree}`].join("\n"),
      canonicalTree,
    )).toBe(true);
  });

  test("directive keys are case-SENSITIVE (systemd ignores a mis-cased key)", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);
    // systemd logs "Unknown key 'workingdirectory' ... ignoring" and the
    // directive has NO effect, so a mis-cased key must NOT match — otherwise we
    // would restart a unit whose active configuration does not use the tree.
    expect(unitTextMentionsTree(`[Service]\nworkingdirectory=${canonicalTree}\n`, canonicalTree)).toBe(false);
    expect(unitTextMentionsTree(`[Service]\nWORKINGDIRECTORY=${canonicalTree}\n`, canonicalTree)).toBe(false);
    expect(unitTextMentionsTree(`[Service]\nexecstart=${canonicalTree}/flair start\n`, canonicalTree)).toBe(false);
    // control: the canonical spelling still matches.
    expect(unitTextMentionsTree(`[Service]\nWorkingDirectory=${canonicalTree}\n`, canonicalTree)).toBe(true);
  });

  test("a comment after a backslash-continued line is ignored and the continuation joins what follows (systemd.syntax(7))", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);

    // A) systemd ignores the comment and the continuation has nothing after it,
    //    so only /bin/echo is an operand -> nomatch. Flushing the comment into
    //    the value would read the tree path and match (a false positive).
    expect(unitTextMentionsTree(
      ["[Service]", "ExecStart=/bin/echo \\", `# ${canonicalTree}/flair`].join("\n"),
      canonicalTree,
    )).toBe(false);

    // B) the man-page shape: the continuation joins the line AFTER the comment
    //    block, so the tree operand is present -> match. Dropping it is the miss
    //    that sends `flair upgrade` back outside the unit.
    expect(unitTextMentionsTree(
      ["[Service]", "ExecStart=/usr/bin/env \\", "# start flair", `${canonicalTree}/flair start`].join("\n"),
      canonicalTree,
    )).toBe(true);
  });

  test("a literal trailing backslash in an operand is not the tree (pins the Bun/Node realpath divergence)", () => {
    const tree = join(tmp, "srv", "flair");
    writeFlairTree(tree, { version: "0.36.0" });
    const canonicalTree = realpathSync(tree);

    // Bun's `realpathSync` silently drops a trailing backslash and would
    // resolve this to the tree; Node throws ENOENT, so the ancestor walk
    // yields `tree + "\\"` (≠ tree) — production's behaviour. Gating realpath
    // on `existsSync` (strict in both) keeps the two runtimes in agreement, so
    // this asserts the Node/production answer. The unit spells the backslash as
    // `\\` (systemd escape for a LITERAL backslash) so it is NOT a continuation.
    expect(unitTextMentionsTree(
      ["[Service]", `WorkingDirectory=${canonicalTree}\\\\`].join("\n"),
      canonicalTree,
    )).toBe(false);
    expect(unitTextMentionsTree(
      ["[Service]", `ExecStart=${canonicalTree}\\\\`].join("\n"),
      canonicalTree,
    )).toBe(false);
  });

  test("finds a system unit that names the tree and ignores one that does not", () => {
    const systemDir = join(tmp, "system");
    const userDir = join(tmp, "user");
    mkdirSync(systemDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(systemDir, "flair.service"),
      "[Service]\nWorkingDirectory=/opt/flair-spoke\nExecStart=/opt/flair-spoke/flair start\n",
    );
    writeFileSync(
      join(systemDir, "unrelated.service"),
      "[Service]\nWorkingDirectory=/var/lib/other\n",
    );
    writeFileSync(join(systemDir, "not-a-unit.conf"), "WorkingDirectory=/opt/flair-spoke\n");
    const units = findSystemdUnitsForTree("/opt/flair-spoke", {
      systemDirs: [systemDir],
      userDir,
      envUnit: "",
    });
    expect(units).toEqual([
      { name: "flair.service", path: join(systemDir, "flair.service"), scope: "system" },
    ]);
  });

  test("FLAIR_SYSTEMD_UNIT adds an explicit unit even when the file does not mention the tree", () => {
    const systemDir = join(tmp, "system");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "spoke.service"), "[Service]\nExecStart=/usr/local/bin/spoke\n");
    const units = findSystemdUnitsForTree("/opt/flair-spoke", {
      systemDirs: [systemDir],
      userDir: join(tmp, "user"),
      envUnit: "system:spoke.service",
    });
    expect(units.map((u) => u.name)).toEqual(["spoke.service"]);
  });

  test("systemdRestartArgs is --user only for user units", () => {
    expect(systemdRestartArgs({ name: "flair.service", path: "/x", scope: "system" }))
      .toEqual(["restart", "flair.service"]);
    expect(systemdRestartArgs({ name: "flair.service", path: "/x", scope: "user" }))
      .toEqual(["--user", "restart", "flair.service"]);
  });
});

describe("apply + restore (injected pack/install)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makePackTgz(version: string): Promise<string> {
    // npm pack tarballs extract to a `package/` prefix; apply() uses strip: 1.
    const src = join(tmp, `pack-src-${version}`);
    const pkg = join(src, "package");
    writeFlairTree(pkg, { version });
    writeFileSync(join(pkg, "README.md"), `flair ${version}\n`);
    const tgz = join(tmp, `tpsdev-ai-flair-${version}.tgz`);
    await tarCreate({ gzip: true, cwd: src, file: tgz, portable: true }, ["package"]);
    return tgz;
  }

  test("swap moves the live tree aside, lands the new version, keeps the launcher", async () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, {
      version: "0.36.0",
      extras: { flair: "#!/bin/sh\n# operator launcher\n" },
    });
    const tgz = await makePackTgz("0.50.0");
    const plan = planPlainTreeUpgrade({
      treeDir: tree,
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
    });
    expect(plan.preserve).toContain("flair");

    const exec: ExecFile = (file, args, opts) => {
      if (file === "npm" && args[0] === "pack") {
        const dest = args[args.indexOf("--pack-destination") + 1];
        cpSync(tgz, join(dest, `tpsdev-ai-flair-0.50.0.tgz`));
        return "tpsdev-ai-flair-0.50.0.tgz\n";
      }
      if (file === "npm" && args[0] === "install") {
        const cwd = typeof opts?.cwd === "string" ? opts.cwd : plan.stagingDir;
        mkdirSync(join(cwd, "node_modules", "harper"), { recursive: true });
        writeFileSync(join(cwd, "node_modules", "harper", "ok"), "1");
        return "";
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    };

    await applyPlainTreeUpgrade(plan, { exec });

    expect(JSON.parse(readFileSync(join(tree, "package.json"), "utf-8")).version).toBe("0.50.0");
    expect(readFileSync(join(tree, "flair"), "utf-8")).toContain("operator launcher");
    expect(existsSync(join(tree, "node_modules", "harper", "ok"))).toBe(true);
    expect(existsSync(plan.previousDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(plan.previousDir, "package.json"), "utf-8")).version).toBe("0.36.0");
    expect(existsSync(plan.stagingDir)).toBe(false);

    expect(restorePlainTreePrevious(plan)).toBe(true);
    expect(JSON.parse(readFileSync(join(tree, "package.json"), "utf-8")).version).toBe("0.36.0");
    expect(readFileSync(join(tree, "flair"), "utf-8")).toContain("operator launcher");
    expect(existsSync(plan.previousDir)).toBe(false);
  });

  test("preserve keeps a root symlink as a symlink", async () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, { version: "0.36.0" });
    const target = join(tmp, "wrapper.sh");
    writeFileSync(target, "#!/bin/sh\n");
    symlinkSync(target, join(tree, "flair"));
    const tgz = await makePackTgz("0.50.0");
    const plan = planPlainTreeUpgrade({
      treeDir: tree,
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
    });
    const exec: ExecFile = (file, args, opts) => {
      if (file === "npm" && args[0] === "pack") {
        const dest = args[args.indexOf("--pack-destination") + 1];
        cpSync(tgz, join(dest, `tpsdev-ai-flair-0.50.0.tgz`));
        return "tpsdev-ai-flair-0.50.0.tgz\n";
      }
      if (file === "npm" && args[0] === "install") {
        const cwd = typeof opts?.cwd === "string" ? opts.cwd : plan.stagingDir;
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        return "";
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    };
    await applyPlainTreeUpgrade(plan, { exec });
    expect(isSymlink(join(tree, "flair"))).toBe(true);
  });

  test("restore is false when there is no previous tree", () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, { version: "0.36.0" });
    const plan = planPlainTreeUpgrade({
      treeDir: tree,
      fromVersion: "0.36.0",
      toVersion: "0.50.0",
    });
    expect(restorePlainTreePrevious(plan)).toBe(false);
  });

  test("discardPlainTreePrevious removes the sibling after verify", () => {
    const tree = join(tmp, "spoke");
    writeFlairTree(tree, { version: "0.36.0" });
    const prev = treeSibling(tree, UPGRADE_PREV_SUFFIX);
    mkdirSync(prev, { recursive: true });
    writeFileSync(join(prev, "gone"), "1");
    discardPlainTreePrevious(prev);
    expect(existsSync(prev)).toBe(false);
  });
});

describe("isNpmGlobalTree", () => {
  test("same path is global; distinct path is not", () => {
    const global: FlairPackageLocation = { dir: "/usr/lib/node_modules/@tpsdev-ai/flair", version: "0.28.0" };
    expect(isNpmGlobalTree(global.dir, global)).toBe(true);
    expect(isNpmGlobalTree("/opt/flair-spoke", global)).toBe(false);
    expect(isNpmGlobalTree("/opt/flair-spoke", null)).toBe(false);
  });
});

describe("resolvePlainTreeListingTarget", () => {
  test("pin wins after consulting registry latest", () => {
    expect(resolvePlainTreeListingTarget({ registryLatest: "0.51.2", pin: "0.40.0" }))
      .toEqual({ version: "0.40.0", pinned: true });
  });

  test("pin still applies when registry latest is unavailable", () => {
    expect(resolvePlainTreeListingTarget({ registryLatest: null, pin: "0.40.0" }))
      .toEqual({ version: "0.40.0", pinned: true });
    expect(resolvePlainTreeListingTarget({ registryLatest: "unknown", pin: " 0.40.0 " }))
      .toEqual({ version: "0.40.0", pinned: true });
  });

  test("without a pin, uses registry latest", () => {
    expect(resolvePlainTreeListingTarget({ registryLatest: "0.51.2", pin: null }))
      .toEqual({ version: "0.51.2", pinned: false });
  });

  test("without a pin and no latest, cannot list", () => {
    expect(resolvePlainTreeListingTarget({ registryLatest: null, pin: null })).toBeNull();
    expect(resolvePlainTreeListingTarget({ registryLatest: "", pin: "  " })).toBeNull();
  });
});

describe("decidePlainTreeRollback", () => {
  test("restores when a previous tree exists", () => {
    expect(decidePlainTreeRollback(true)).toEqual({ kind: "restore" });
  });

  test("skips without crashing when no previous tree exists", () => {
    const decision = decidePlainTreeRollback(false);
    expect(decision.kind).toBe("skip");
    if (decision.kind !== "skip") return;
    expect(decision.reason).toContain("not swapped");
  });
});
