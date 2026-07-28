// upgrade-restart-resolution.test.ts — Unit tests for flair#905: resolving the
// Harper binary and the newly-installed CLI ACROSS a package swap.
//
// The bug these guard against, stated as the invariant they encode: after
// `flair upgrade` replaces @tpsdev-ai/flair's package tree, nothing the running
// process compiled in still describes that tree. 0.29.0 → 0.30.0 renamed the
// Harper dependency (`@harperfast/harper` → `harper`, flair#870); 0.29.0's
// resolver only ever probed the scoped name, so the post-swap restart reported
// "Harper binary not found. Run 'flair init' first." on a completely intact
// install — and left the instance down behind an error naming the wrong remedy.
//
// These are filesystem-fixture tests, not mocks: `resolveHarperBin` is a
// question about what is on disk, and a stubbed `existsSync` would let a
// resolver that builds the wrong path pass. Fixtures are real directories in a
// per-test temp dir; nothing here touches ~/.flair or spawns anything.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredHarperPackageNames,
  resolveHarperBin,
  harperBinNotFoundMessage,
  resolveInstalledFlairCli,
  parseListeningPids,
} from "../../src/cli";

let root: string;

/** Materialise `<root>/<name>/node_modules/<harperPkg>/dist/bin/harper.js` plus
 * a package.json declaring `declares` as dependencies. Returns the package root. */
function makeTree(name: string, opts: { declares?: Record<string, string>; installs?: string[]; version?: string }): string {
  const pkgRoot = join(root, name);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({ name: "@tpsdev-ai/flair", version: opts.version ?? "9.9.9", dependencies: opts.declares ?? {} }),
  );
  for (const installed of opts.installs ?? []) {
    const binDir = join(pkgRoot, "node_modules", ...installed.split("/"), "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "harper.js"), "// fixture\n");
  }
  return pkgRoot;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "flair905-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("declaredHarperPackageNames [flair#905]", () => {
  test("reads the Harper dependency name off the package.json at the given root", () => {
    const pkgRoot = makeTree("declares-bare", { declares: { harper: "5.1.22", commander: "14.0.3" } });
    expect(declaredHarperPackageNames(pkgRoot)).toEqual(["harper"]);
  });

  test("matches a scoped Harper name too", () => {
    const pkgRoot = makeTree("declares-scoped", { declares: { "@harperfast/harper": "5.1.22" } });
    expect(declaredHarperPackageNames(pkgRoot)).toEqual(["@harperfast/harper"]);
  });

  // The filter has to be anchored: `harper-fabric-embeddings` is a real
  // dependency of this package and is emphatically not a Harper engine.
  test("does not match other harper-prefixed dependencies", () => {
    const pkgRoot = makeTree("declares-embeddings", {
      declares: { "harper-fabric-embeddings": "^0.5.0", "@harperfast/oauth": "2.4.0" },
    });
    expect(declaredHarperPackageNames(pkgRoot)).toEqual([]);
  });

  test("returns [] rather than throwing when there is no readable package.json", () => {
    expect(declaredHarperPackageNames(join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("resolveHarperBin [flair#905]", () => {
  test("finds a Harper installed under the name the tree declares", () => {
    const pkgRoot = makeTree("bare", { declares: { harper: "5.1.22" }, installs: ["harper"] });
    const res = resolveHarperBin([pkgRoot]);
    expect(res.path).toBe(join(pkgRoot, "node_modules", "harper", "dist", "bin", "harper.js"));
  });

  test("finds a legacy scoped Harper that the tree no longer declares", () => {
    // A pre-#870 install being started by current code: package.json says
    // `harper`, node_modules still holds the scoped copy that is actually
    // serving the data dir. The known-names fallback is what keeps it booting.
    const pkgRoot = makeTree("legacy", { declares: { harper: "5.1.22" }, installs: ["@harperfast/harper"] });
    const res = resolveHarperBin([pkgRoot]);
    expect(res.path).toBe(join(pkgRoot, "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js"));
  });

  // ── The flair#905 regression, reduced to its essentials ──────────────────
  // A FUTURE rename: the tree declares and installs a Harper under a name this
  // build has never heard of. 0.29.0 answered `null` to exactly this question
  // and took the instance down. Reading the name off the post-swap package.json
  // is what makes the answer come from the tree instead of from the binary.
  test("finds a Harper under a package name this build does not hardcode", () => {
    const pkgRoot = makeTree("renamed", {
      declares: { "@harperfast-next/harper": "6.0.0" },
      installs: ["@harperfast-next/harper"],
    });
    const res = resolveHarperBin([pkgRoot]);
    expect(res.path).toBe(join(pkgRoot, "node_modules", "@harperfast-next", "harper", "dist", "bin", "harper.js"));
  });

  test("prefers the declared name when a tree carries two Harpers", () => {
    const pkgRoot = makeTree("both", {
      declares: { harper: "5.1.22" },
      installs: ["harper", "@harperfast/harper"],
    });
    expect(resolveHarperBin([pkgRoot]).path).toBe(join(pkgRoot, "node_modules", "harper", "dist", "bin", "harper.js"));
  });

  test("reports every path it tried when nothing is found", () => {
    const pkgRoot = makeTree("empty", { declares: { harper: "5.1.22" } });
    const res = resolveHarperBin([pkgRoot]);
    expect(res.path).toBeNull();
    expect(res.searched).toContain(join(pkgRoot, "node_modules", "harper", "dist", "bin", "harper.js"));
    expect(res.searched).toContain(join(pkgRoot, "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js"));
    // No duplicates: `harper` is both declared and known, and a search list
    // that repeats itself reads as a bug to whoever is staring at it at 3am.
    expect(new Set(res.searched).size).toBe(res.searched.length);
  });

  test("searches roots in order and stops at the first hit", () => {
    const first = makeTree("root-a", { declares: { harper: "5.1.22" } });
    const second = makeTree("root-b", { declares: { harper: "5.1.22" }, installs: ["harper"] });
    const res = resolveHarperBin([first, second]);
    expect(res.path).toBe(join(second, "node_modules", "harper", "dist", "bin", "harper.js"));
  });
});

describe("harperBinNotFoundMessage [flair#905]", () => {
  const message = harperBinNotFoundMessage(["/x/node_modules/harper/dist/bin/harper.js"]);

  test("names every path that was searched", () => {
    expect(message).toContain("/x/node_modules/harper/dist/bin/harper.js");
  });

  test("names reinstalling the package as the remedy", () => {
    expect(message).toContain("npm install -g @tpsdev-ai/flair");
  });

  // The whole point of flair#905's third ask. The old text was `Harper binary
  // not found. Run 'flair init' first.` — pointing a user with a live data
  // directory at the one command that reads as "re-provision my instance".
  test("does not send the operator to `flair init`", () => {
    expect(message).not.toMatch(/Run ['`]flair init['`] first/);
  });
});

// ─── Kill-by-port safety [flair#800, extended by flair#905] ────────────────
// Found while building the suite above: `flair stop` self-terminated the
// process tree that invoked it. A bare `lsof -ti :<port>` lists every process
// holding ANY socket on the port — including the caller's own keep-alive
// client connections — and `flair stop` SIGTERM'd all of them unfiltered.
// Measured on a live instance: `lsof -ti :19871` returned the Harper PID AND
// the probing process's own PID; `-sTCP:LISTEN` returned the Harper PID only.
describe("parseListeningPids [flair#905]", () => {
  test("drops our own PID even when lsof reports it", () => {
    expect(parseListeningPids("4242\n99\n", 4242)).toEqual([99]);
  });

  test("returns every other listening PID", () => {
    expect(parseListeningPids("11\n22\n33\n", 4242)).toEqual([11, 22, 33]);
  });

  test("treats empty or whitespace output as nothing running", () => {
    expect(parseListeningPids("", 1)).toEqual([]);
    expect(parseListeningPids("\n  \n", 1)).toEqual([]);
  });

  test("drops non-numeric and non-positive entries rather than signalling them", () => {
    // `process.kill(0, ...)` signals the whole process GROUP, and NaN throws —
    // neither belongs in a list about to be handed to kill().
    expect(parseListeningPids("0\n-1\nnope\n77\n", 1)).toEqual([77]);
  });
});

describe("resolveInstalledFlairCli [flair#905]", () => {
  test("resolves dist/cli.js and the version the tree reports", () => {
    const pkgRoot = makeTree("installed", { version: "0.31.0" });
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(join(pkgRoot, "dist", "cli.js"), "// fixture\n");
    const res = resolveInstalledFlairCli(pkgRoot, "0.31.0");
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ cliPath: join(pkgRoot, "dist", "cli.js"), version: "0.31.0" });
  });

  // npm reporting success is not the same as the new version landing where we
  // are about to look — a custom prefix or a shadowed global install both end
  // with an intact-looking tree holding the OLD code. Restarting through that
  // is the failure this check exists to refuse.
  test("refuses a tree holding a version other than the one expected", () => {
    const pkgRoot = makeTree("stale", { version: "0.29.0" });
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(join(pkgRoot, "dist", "cli.js"), "// fixture\n");
    const res = resolveInstalledFlairCli(pkgRoot, "0.30.0");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining("holds 0.29.0, expected 0.30.0") });
  });

  test("accepts any version when no expectation is supplied", () => {
    const pkgRoot = makeTree("unpinned", { version: "0.29.0" });
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(join(pkgRoot, "dist", "cli.js"), "// fixture\n");
    expect(resolveInstalledFlairCli(pkgRoot, null).ok).toBe(true);
  });

  test("reports the missing dist/cli.js path rather than a bare failure", () => {
    const pkgRoot = makeTree("no-dist", { version: "0.30.0" });
    const res = resolveInstalledFlairCli(pkgRoot, "0.30.0");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining(join(pkgRoot, "dist", "cli.js")) });
  });

  test("reports an unreadable package.json rather than throwing", () => {
    const pkgRoot = join(root, "broken-json");
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(join(pkgRoot, "dist", "cli.js"), "// fixture\n");
    writeFileSync(join(pkgRoot, "package.json"), "{ not json");
    const res = resolveInstalledFlairCli(pkgRoot, "0.30.0");
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining("package.json") });
  });
});
