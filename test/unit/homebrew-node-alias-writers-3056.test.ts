/**
 * homebrew-node-alias-writers-3056.test.ts — flair#3056.
 *
 * On a Homebrew Node install the running binary is the realpath
 * `<prefix>/Cellar/<formula>/<version>/bin/node`, and `brew upgrade` deletes
 * that directory. These tests build a REAL Homebrew layout in a temp dir (a
 * Cellar binary and an `opt/<formula>` symlink, no fake path table) and drive
 * the writers that record a node path:
 *
 *   - the launchd plist writer (`writeInitLaunchdPlist`, adopted-plist re-point);
 *   - the federation-sync shim writers (`enableScheduler` for a new shim,
 *     `rewriteFederationSchedulerRuntime` for an existing one).
 *
 * An existing plist or shim that records a Cellar path is rewritten to the opt
 * alias when that alias resolves to the same binary; a Cellar path whose alias
 * now resolves to another version, and a path outside the Cellar layout, are
 * kept. No launchctl or systemctl; the files the writers touch are under the
 * temp dir.
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildLaunchdPlist, writeInitLaunchdPlist, type WriteInitLaunchdPlistOptions } from "../../src/cli.ts";
import { enableScheduler, rewriteFederationSchedulerRuntime } from "../../src/federation/scheduler.ts";
import { resolveHome } from "../../src/lib/home.ts";

const templateRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "templates");
const LABEL = "ai.tpsdev.flair.cafe3056";

interface Brew {
  root: string;
  prefix: string;
  /** `<prefix>/Cellar/<formula>/<version>/bin/node`, a real file. */
  cellar: (formula: string, version: string) => string;
  /** Point `<prefix>/opt/<formula>` at `../Cellar/<formula>/<version>`; returns `<prefix>/opt/<formula>/bin/node`. */
  opt: (formula: string, version: string) => string;
  tree: string;
  cli: string;
  harper: string;
  launcher: string;
}

/** A Homebrew prefix with installed node binaries and an npm-global flair tree under it. */
function brew(): Brew {
  const root = tempDir("flair-3056-brew-");
  const prefix = join(root, "homebrew");
  const tree = join(prefix, "lib", "node_modules", "@tpsdev-ai", "flair");
  const harper = join(tree, "node_modules", "harper", "dist", "bin", "harper.js");
  const launcher = join(tree, "templates", "launchd", "start-flair-with-admin-pass.sh");
  mkdirSync(dirname(harper), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  mkdirSync(join(tree, "dist"), { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.62.0" }));
  writeFileSync(join(tree, "dist", "cli.js"), "// flair\n");
  writeFileSync(harper, "// harper\n");
  writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
  const cellar = (formula: string, version: string): string => {
    const node = join(prefix, "Cellar", formula, version, "bin", "node");
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, `#!/bin/sh\n# ${formula} ${version}\n`, { mode: 0o755 });
    return node;
  };
  const opt = (formula: string, version: string): string => {
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync(join("..", "Cellar", formula, version), join(prefix, "opt", formula));
    return join(prefix, "opt", formula, "bin", "node");
  };
  return { root, prefix, cellar, opt, tree, cli: join(tree, "dist", "cli.js"), harper, launcher };
}

// ─── the launchd plist writer ───────────────────────────────────────────────

function plistOptions(b: Brew, execPath: string): WriteInitLaunchdPlistOptions {
  const dataDir = join(b.root, "data");
  return {
    dataDir,
    plistPath: join(b.root, `${LABEL}.plist`),
    label: LABEL,
    adminPass: "",
    adminUser: "admin",
    modelsDir: join(dataDir, "models"),
    execPath,
    harperBinPath: b.harper,
    workingDirectory: b.tree,
    httpPort: 9926,
    opsNetworkPort: "9925",
    setConfig: JSON.stringify({ rootPath: dataDir, http: { port: 9926 } }),
    port: 9926,
    adminPassPath: join(b.root, "admin-pass"),
    liveInstance: false,
  };
}

/** The adopted pass-file plist `flair init` writes for this tree, recording `node`. */
function adoptedPlist(b: Brew, opts: WriteInitLaunchdPlistOptions, node: string): string {
  return buildLaunchdPlist({
    label: LABEL,
    execPath: node,
    harperBinPath: b.harper,
    workingDirectory: b.tree,
    dataDir: opts.dataDir,
    modelsDir: opts.modelsDir,
    setConfig: opts.setConfig,
    adminUser: "admin",
    httpPort: 9926,
    opsNetworkPort: "9925",
    passFile: { launcher: b.launcher, adminPassFile: opts.adminPassPath!, home: resolveHome(), path: "/usr/bin:/bin" },
  });
}

/** ProgramArguments, in order, as written in the plist. */
function programArguments(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) throw new Error("no ProgramArguments array in the plist");
  return [...block[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
}

describe("launchd plist writer: an adopted plist that records a Cellar node (flair#3056)", () => {
  test("is rewritten to the opt alias when the alias resolves to the same binary", async () => {
    const b = brew();
    const cellar = b.cellar("node", "26.10.0_1");
    const alias = b.opt("node", "26.10.0_1");
    // `flair init` passes the alias it computed for its own runtime.
    const opts = plistOptions(b, alias);
    const before = adoptedPlist(b, opts, cellar);
    writeFileSync(opts.plistPath, before);
    expect(programArguments(before)[2]).toBe(cellar);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("repointed");
    const after = readFileSync(opts.plistPath, "utf-8");
    expect(programArguments(after)).toEqual([b.launcher, opts.adminPassPath!, alias, b.harper]);
    // Only the node path changed.
    expect(after).toBe(adoptedPlist(b, opts, alias));
  });

  test("a Cellar path whose opt alias now resolves to ANOTHER version is kept", async () => {
    const b = brew();
    const cellar = b.cellar("node", "26.10.0_1");
    b.cellar("node", "26.12.1");
    const alias = b.opt("node", "26.12.1");
    const opts = plistOptions(b, alias);
    const before = adoptedPlist(b, opts, cellar);
    writeFileSync(opts.plistPath, before);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("unchanged");
    expect(readFileSync(opts.plistPath, "utf-8")).toBe(before);
  });

  test("a node path outside the Cellar layout is kept", async () => {
    const b = brew();
    const cellar = b.cellar("node", "26.10.0_1");
    const alias = b.opt("node", "26.10.0_1");
    const binNode = join(b.prefix, "bin", "node");
    mkdirSync(dirname(binNode), { recursive: true });
    symlinkSync(cellar, binNode);
    const opts = plistOptions(b, alias);
    const before = adoptedPlist(b, opts, binNode);
    writeFileSync(opts.plistPath, before);

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("unchanged");
    expect(readFileSync(opts.plistPath, "utf-8")).toBe(before);
  });

  test("a node@22 Cellar path is rewritten to opt/node@22, not to this CLI's node", async () => {
    const b = brew();
    const pinned = b.cellar("node@22", "22.11.0");
    const pinnedAlias = b.opt("node@22", "22.11.0");
    b.cellar("node", "26.10.0_1");
    const cliAlias = b.opt("node", "26.10.0_1");
    const opts = plistOptions(b, cliAlias);
    writeFileSync(opts.plistPath, adoptedPlist(b, opts, pinned));

    const result = await writeInitLaunchdPlist(opts);

    expect(result.kind).toBe("repointed");
    expect(readFileSync(opts.plistPath, "utf-8")).toBe(adoptedPlist(b, opts, pinnedAlias));
  });
});

// ─── the federation-sync shim writers ───────────────────────────────────────

const execLine = (text: string): string | undefined => text.split("\n").find((l) => l.startsWith("exec "));

interface ShimPaths {
  shim: string;
  plist: string;
  service: string;
  timer: string;
  home: string;
}

function shimPaths(b: Brew): ShimPaths {
  const home = join(b.root, "home");
  mkdirSync(join(home, ".flair", "bin"), { recursive: true });
  writeFileSync(join(home, ".flair", "admin-pass"), "x\n", { mode: 0o600 });
  return {
    home,
    shim: join(home, ".flair", "bin", "flair-federation-sync"),
    plist: join(home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist"),
    service: join(home, ".config", "systemd", "user", "flair-federation-sync.service"),
    timer: join(home, ".config", "systemd", "user", "flair-federation-sync.timer"),
  };
}

function enable(b: Brew, p: ShimPaths, platform: "darwin" | "linux", node: { nodeBin?: string; defaultNodeBin?: string }): void {
  enableScheduler({
    intervalSeconds: 300,
    adminPassFile: join(p.home, ".flair", "admin-pass"),
    flairBin: b.cli,
    ...node,
    platformOverride: platform,
    shimPathOverride: p.shim,
    launchdPlistOverride: p.plist,
    systemdServiceOverride: p.service,
    systemdTimerOverride: p.timer,
    homeOverride: p.home,
    templateRootOverride: templateRoot,
    skipLoad: true,
  });
}

/** `flair init`'s shim re-point, with this CLI running `nodeBin` from the same tree. */
function rewrite(b: Brew, p: ShimPaths, platform: "darwin" | "linux", nodeBin: string, dryRun = false) {
  return rewriteFederationSchedulerRuntime({
    platformOverride: platform,
    shimPathOverride: p.shim,
    launchdPlistOverride: p.plist,
    systemdServiceOverride: p.service,
    templateRootOverride: templateRoot,
    nodeBin,
    flairBin: b.cli,
    dryRun,
  });
}

describe("federation-sync shim writers: a Cellar node (flair#3056)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: enable writes the opt alias for a Cellar runtime`, () => {
      const b = brew();
      const cellar = b.cellar("node", "26.10.0_1");
      const alias = b.opt("node", "26.10.0_1");
      const p = shimPaths(b);

      enable(b, p, platform, { defaultNodeBin: cellar });

      expect(execLine(readFileSync(p.shim, "utf-8"))).toBe(`exec "${alias}" "${b.cli}" federation sync "$@"`);
    });

    test(`${platform}: an existing shim that records a Cellar node is rewritten to the opt alias`, () => {
      const b = brew();
      const cellar = b.cellar("node", "26.10.0_1");
      const alias = b.opt("node", "26.10.0_1");
      const p = shimPaths(b);
      enable(b, p, platform, { nodeBin: cellar });
      expect(execLine(readFileSync(p.shim, "utf-8"))).toBe(`exec "${cellar}" "${b.cli}" federation sync "$@"`);

      const r = rewrite(b, p, platform, alias);

      expect(r.status).toBe("rewritten");
      expect(execLine(readFileSync(p.shim, "utf-8"))).toBe(`exec "${alias}" "${b.cli}" federation sync "$@"`);
      expect(rewrite(b, p, platform, alias, true).status).toBe("current");
    });
  }

  test("a Cellar path whose opt alias now resolves to ANOTHER version is kept", () => {
    const b = brew();
    const cellar = b.cellar("node", "26.10.0_1");
    b.cellar("node", "26.12.1");
    const alias = b.opt("node", "26.12.1");
    const p = shimPaths(b);
    enable(b, p, "darwin", { nodeBin: cellar });
    const before = readFileSync(p.shim, "utf-8");

    const r = rewrite(b, p, "darwin", alias);

    expect(r.status).toBe("pinned-node");
    expect(readFileSync(p.shim, "utf-8")).toBe(before);
  });

  test("a node path outside the Cellar layout is kept", () => {
    const b = brew();
    const cellar = b.cellar("node", "26.10.0_1");
    const alias = b.opt("node", "26.10.0_1");
    const binNode = join(b.prefix, "bin", "node");
    mkdirSync(dirname(binNode), { recursive: true });
    symlinkSync(cellar, binNode);
    const p = shimPaths(b);
    enable(b, p, "darwin", { nodeBin: binNode });
    const before = readFileSync(p.shim, "utf-8");

    const r = rewrite(b, p, "darwin", alias);

    expect(r.status).toBe("current");
    expect(readFileSync(p.shim, "utf-8")).toBe(before);
  });

  test("a node@22 Cellar path is rewritten to opt/node@22, not to this CLI's node", () => {
    const b = brew();
    const pinned = b.cellar("node@22", "22.11.0");
    const pinnedAlias = b.opt("node@22", "22.11.0");
    b.cellar("node", "26.10.0_1");
    const cliAlias = b.opt("node", "26.10.0_1");
    const p = shimPaths(b);
    enable(b, p, "darwin", { nodeBin: pinned });

    const r = rewrite(b, p, "darwin", cliAlias);

    expect(r.status).toBe("rewritten");
    expect(execLine(readFileSync(p.shim, "utf-8"))).toBe(`exec "${pinnedAlias}" "${b.cli}" federation sync "$@"`);
    expect(rewrite(b, p, "darwin", cliAlias, true).status).toBe("pinned-node");
  });
});
