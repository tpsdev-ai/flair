/**
 * federation-sync-runtime-rewrite-2034.test.ts — flair#2034 §2.
 *
 * The federation-sync shim bakes the node + flair paths of the runtime that
 * enabled it. `flair init` / `flair doctor --fix` re-point it at this CLI's
 * install tree by changing ONLY the shim's exec line. The scheduler unit holds
 * no runtime path and must come out byte-identical — operator-set interval,
 * target (with an XML-escaped `&`), pass-file, a custom PATH and RunAtLoad
 * included. Unreadable / hand-changed units and shims are refused; a failed
 * write leaves the old shim intact.
 *
 * The fixture pair is written by the real `enableScheduler` (skipLoad) into a
 * scratch directory. No launchctl, no systemctl, no real HOME.
 */
import { describe, test, expect } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  enableScheduler,
  rewriteFederationSchedulerRuntime,
  type RewriteFederationRuntimeOpts,
} from "../../src/federation/scheduler.ts";
import { preferVersionManagerAlias } from "../../src/lib/node-alias-path.ts";

const templateRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "templates");

interface Fixture {
  root: string;
  home: string;
  shim: string;
  plist: string;
  service: string;
  timer: string;
  oldNode: string;
  oldCli: string;
  newNode: string;
  newCli: string;
  newTree: string;
}

/** A runtime prefix with node + an npm-global flair tree at `version`. */
function runtime(root: string, name: string, version: string): { node: string; cli: string; tree: string } {
  const prefix = join(root, "runtimes", name);
  const tree = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
  mkdirSync(join(tree, "dist"), { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version }));
  writeFileSync(join(tree, "dist", "cli.js"), "// flair\n");
  writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  return { node: join(prefix, "bin", "node"), cli: join(tree, "dist", "cli.js"), tree };
}

function fixture(opts: { oldVersion?: string; oldTree?: "npm" | "plain" } = {}): Fixture {
  const root = tempDir("flair-2034-fed-");
  // A HOME with an ampersand and a space: every path in the plist is escaped.
  const home = join(root, "R&D home");
  mkdirSync(join(home, ".flair", "bin"), { recursive: true });
  const old = runtime(root, "24.18.0", opts.oldVersion ?? "0.57.0");
  const cur = runtime(root, "24.19.0", "0.57.0");
  let oldCli = old.cli;
  if (opts.oldTree === "plain") {
    const plain = join(root, "opt", "flair");
    mkdirSync(join(plain, "dist"), { recursive: true });
    writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.57.0" }));
    writeFileSync(join(plain, "dist", "cli.js"), "// plain\n");
    oldCli = join(plain, "dist", "cli.js");
  }
  return {
    root,
    home,
    shim: join(home, ".flair", "bin", "flair-federation-sync"),
    plist: join(home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist"),
    service: join(home, ".config", "systemd", "user", "flair-federation-sync.service"),
    timer: join(home, ".config", "systemd", "user", "flair-federation-sync.timer"),
    oldNode: old.node,
    oldCli,
    newNode: cur.node,
    newCli: cur.cli,
    newTree: cur.tree,
  };
}

function enable(f: Fixture, platform: "darwin" | "linux"): void {
  const passFile = join(f.home, ".flair", "admin-pass");
  writeFileSync(passFile, "x\n", { mode: 0o600 });
  enableScheduler({
    intervalSeconds: 600,
    adminPassFile: passFile,
    target: "https://hub.example/sync?a=1&b=2",
    flairBin: f.oldCli,
    nodeBin: f.oldNode,
    platformOverride: platform,
    shimPathOverride: f.shim,
    launchdPlistOverride: f.plist,
    systemdServiceOverride: f.service,
    systemdTimerOverride: f.timer,
    homeOverride: f.home,
    templateRootOverride: templateRoot,
    skipLoad: true,
  });
}

function rewrite(f: Fixture, platform: "darwin" | "linux", over: RewriteFederationRuntimeOpts = {}) {
  return rewriteFederationSchedulerRuntime({
    platformOverride: platform,
    shimPathOverride: f.shim,
    launchdPlistOverride: f.plist,
    systemdServiceOverride: f.service,
    nodeBin: f.newNode,
    flairBin: f.newCli,
    ...over,
  });
}

const execLine = (text: string) => text.split("\n").find((l) => l.startsWith("exec "));

describe("rewriteFederationSchedulerRuntime — macOS", () => {
  test("re-points ONLY the shim's exec line; the plist, with operator edits, stays byte-identical", () => {
    const f = fixture();
    enable(f, "darwin");
    // Operator edits the unit by hand: a custom PATH and RunAtLoad off.
    const edited = readFileSync(f.plist, "utf-8")
      .replace("<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>", "<string>/custom/bin:/usr/bin:/bin</string>")
      .replace("<key>RunAtLoad</key>\n  <true/>", "<key>RunAtLoad</key>\n  <false/>");
    expect(edited).toContain("<false/>");
    expect(edited).toContain("R&amp;D home");
    expect(edited).toContain("a=1&amp;b=2");
    writeFileSync(f.plist, edited);
    const shimBefore = readFileSync(f.shim, "utf-8");

    const r = rewrite(f, "darwin");
    expect(r.status).toBe("rewritten");
    expect(readFileSync(f.plist, "utf-8")).toBe(edited);

    const shimAfter = readFileSync(f.shim, "utf-8");
    expect(execLine(shimAfter)).toBe(`exec "${f.newNode}" "${f.newCli}" federation sync "$@"`);
    const others = (t: string) => t.split("\n").filter((l) => !l.startsWith("exec "));
    expect(others(shimAfter)).toEqual(others(shimBefore));
    expect(statSync(f.shim).mode & 0o777).toBe(0o700);
  });

  test("idempotent: a second run is `current` and writes nothing", () => {
    const f = fixture();
    enable(f, "darwin");
    expect(rewrite(f, "darwin").status).toBe("rewritten");
    const shim = readFileSync(f.shim, "utf-8");
    const mtime = statSync(f.shim).mtimeMs;
    expect(rewrite(f, "darwin").status).toBe("current");
    expect(readFileSync(f.shim, "utf-8")).toBe(shim);
    expect(statSync(f.shim).mtimeMs).toBe(mtime);
  });

  test("dry run reports what would change and writes nothing", () => {
    const f = fixture();
    enable(f, "darwin");
    const before = readFileSync(f.shim, "utf-8");
    const r = rewrite(f, "darwin", { dryRun: true });
    expect(r.status).toBe("would-rewrite");
    expect(r.to).toEqual({ nodeBin: f.newNode, flairBin: f.newCli });
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("a leftover shim with no unit (federation sync disabled) is NOT rewritten", () => {
    const f = fixture();
    enable(f, "darwin");
    unlinkSync(f.plist);
    const before = readFileSync(f.shim, "utf-8");
    const r = rewrite(f, "darwin");
    expect(r.status).toBe("not-enabled");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("an unreadable unit is refused — never blank-filled — and the shim is untouched", () => {
    const f = fixture();
    enable(f, "darwin");
    const before = readFileSync(f.shim, "utf-8");
    const r = rewrite(f, "darwin", {
      read: (p) => {
        if (p === f.plist) throw new Error("EACCES: permission denied");
        return readFileSync(p, "utf-8");
      },
    });
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("EACCES");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("a unit that does not exec the generated shim is refused", () => {
    const f = fixture();
    enable(f, "darwin");
    writeFileSync(f.plist, readFileSync(f.plist, "utf-8").replace(/(<array>\s*<string>)[^<]*(<\/string>)/, "$1/usr/local/bin/my-sync$2"));
    const before = readFileSync(f.shim, "utf-8");
    expect(rewrite(f, "darwin").status).toBe("refused");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("a hand-changed shim (not the generated shape) is refused", () => {
    const f = fixture();
    enable(f, "darwin");
    writeFileSync(f.shim, readFileSync(f.shim, "utf-8").replace("# Deployed by `flair federation sync enable`", "# mine"));
    const before = readFileSync(f.shim, "utf-8");
    expect(rewrite(f, "darwin").status).toBe("refused");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("a failed write leaves the old shim intact and no temp file behind", () => {
    const f = fixture();
    enable(f, "darwin");
    const before = readFileSync(f.shim, "utf-8");
    const r = rewrite(f, "darwin", {
      atomic: {
        rename: () => {
          throw new Error("EIO: simulated rename failure");
        },
      },
    });
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("EIO");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
    expect(readdirSync(dirname(f.shim))).toEqual(["flair-federation-sync"]);
  });

  test("the same tree under a DIFFERENT existing node is a deliberate pin, left alone", () => {
    const f = fixture();
    enable(f, "darwin");
    writeFileSync(f.shim, readFileSync(f.shim, "utf-8").replace(`"${f.oldCli}"`, `"${f.newCli}"`));
    const before = readFileSync(f.shim, "utf-8");
    expect(rewrite(f, "darwin").status).toBe("pinned-node");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
  });

  test("a plain tree or checkout is separately managed and not re-pointed", () => {
    const f = fixture({ oldTree: "plain" });
    enable(f, "darwin");
    expect(rewrite(f, "darwin").status).toBe("separate");
  });

  test("an old tree with a NEWER flair is refused (no downgrade)", () => {
    const f = fixture({ oldVersion: "0.58.0" });
    enable(f, "darwin");
    const r = rewrite(f, "darwin");
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("downgrade");
  });
});

describe("rewriteFederationSchedulerRuntime — Linux", () => {
  test("re-points the shim; the service AND timer units stay byte-identical", () => {
    const f = fixture();
    enable(f, "linux");
    const service = readFileSync(f.service, "utf-8").replace("Type=oneshot", "Type=oneshot\nNice=10");
    writeFileSync(f.service, service);
    const timer = readFileSync(f.timer, "utf-8");
    expect(service).toContain("FLAIR_TARGET=https://hub.example/sync?a=1&b=2");

    const r = rewrite(f, "linux");
    expect(r.status).toBe("rewritten");
    expect(readFileSync(f.service, "utf-8")).toBe(service);
    expect(readFileSync(f.timer, "utf-8")).toBe(timer);
    expect(execLine(readFileSync(f.shim, "utf-8"))).toBe(`exec "${f.newNode}" "${f.newCli}" federation sync "$@"`);
  });

  test("a service unit whose ExecStart is not the shim is refused", () => {
    const f = fixture();
    enable(f, "linux");
    writeFileSync(f.service, readFileSync(f.service, "utf-8").replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/true"));
    expect(rewrite(f, "linux").status).toBe("refused");
  });
});

describe("the node alias policy, enable and re-point agree", () => {
  function miseLayout(root: string) {
    const mise = join(root, "mise");
    const exact = join(mise, "installs", "node", "24.19.0", "bin", "node");
    mkdirSync(dirname(exact), { recursive: true });
    writeFileSync(exact, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("24.19.0", join(mise, "installs", "node", "24"));
    return { mise, exact, alias: join(mise, "installs", "node", "24", "bin", "node") };
  }

  test("a new `federation sync enable` bakes mise's major alias when it is the same binary", () => {
    const f = fixture();
    const m = miseLayout(f.root);
    const passFile = join(f.home, ".flair", "admin-pass");
    writeFileSync(passFile, "x\n", { mode: 0o600 });
    enableScheduler({
      intervalSeconds: 600,
      adminPassFile: passFile,
      flairBin: f.newCli,
      defaultNodeBin: m.exact,
      aliasHooks: { home: f.home, env: { MISE_DATA_DIR: m.mise } },
      platformOverride: "darwin",
      shimPathOverride: f.shim,
      launchdPlistOverride: f.plist,
      homeOverride: f.home,
      templateRootOverride: templateRoot,
      skipLoad: true,
    });
    expect(execLine(readFileSync(f.shim, "utf-8"))).toBe(`exec "${m.alias}" "${f.newCli}" federation sync "$@"`);
  });

  test("a floating alias that moves to another runtime is followed, and then counts as a pin — not rewritten", () => {
    const f = fixture();
    const m = miseLayout(f.root);
    enable(f, "darwin");
    // The shim holds the alias and this CLI's tree, as init/enable would write it.
    writeFileSync(
      f.shim,
      readFileSync(f.shim, "utf-8").replace(`"${f.oldNode}" "${f.oldCli}"`, `"${m.alias}" "${f.newCli}"`),
    );
    // While the alias resolves to the runtime this CLI uses, the shim is current.
    expect(rewrite(f, "darwin", { nodeBin: m.exact }).status).toBe("current");
    // mise retargets the alias to 24.20.0: the shim now runs THAT runtime.
    const next = join(m.mise, "installs", "node", "24.20.0", "bin", "node");
    mkdirSync(dirname(next), { recursive: true });
    writeFileSync(next, "#!/bin/sh\n", { mode: 0o755 });
    rmSync(join(m.mise, "installs", "node", "24"));
    symlinkSync("24.20.0", join(m.mise, "installs", "node", "24"));
    const before = readFileSync(f.shim, "utf-8");
    expect(rewrite(f, "darwin", { nodeBin: m.exact }).status).toBe("pinned-node");
    expect(readFileSync(f.shim, "utf-8")).toBe(before);
    // And the alias is no longer offered for the old exact runtime.
    expect(preferVersionManagerAlias(m.exact, { home: f.home, env: { MISE_DATA_DIR: m.mise } })).toBe(m.exact);
  });
});
