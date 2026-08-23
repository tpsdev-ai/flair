// flair#1342 — doctor/init know pi: detection, native-extension wiring, and
// the flair#1346 misconfiguration callout.
//
// pi is NOT an MCP client (packages/pi-flair/README "Design Decision") — it
// loads @tpsdev-ai/pi-flair through its own settings.json:
//
//   "packages"    package SOURCES (npm:/git:/local, or { source, ...filters })
//                 — where npm:@tpsdev-ai/pi-flair belongs; pi auto-installs a
//                 missing/mismatched npm package at startup and honors an
//                 exact @<version> pin (pi 0.84.2 package-manager.js,
//                 resolvePackageSources).
//   "extensions"  local FILE PATHS only — an npm: spec here is treated as a
//                 path, fails existsSync, and is dropped WITHOUT ERROR. That
//                 silent drop is the flair#1346 field failure these tests
//                 mutation-check: the same spec under "extensions" must
//                 trigger the callout; moved to "packages" it must read clean.
//
// HONESTY: these tests exercise settings-path resolution, scanning, and the
// wire/check round-trip. End-to-end pickup by a live pi (auto-install +
// tool registration) was verified for the npm: packages route in flair#1348's
// validation, not re-run here.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALL_CLIENTS,
  clientConfigPath,
  detectClients,
  extractPiFlairPin,
  isPiFlairNpmSource,
  piFlairSpec,
  piSettingsPath,
  PI_FLAIR_DEFAULT_URL,
  PI_FLAIR_PACKAGE,
  scanPiSettings,
  wirePi,
} from "../../src/install/clients.ts";
import { checkPiFlairWiring } from "../../src/doctor-client.ts";

const ENV = { FLAIR_AGENT_ID: "wirebot", FLAIR_URL: "http://127.0.0.1:19926" };

/** This repo's real version, read straight from package.json — the pin the
 *  wire function must write (pi-flair ships in lockstep with the CLI).
 *  Independent of piFlairSpec() so a regression that unpins BOTH writer and
 *  helper still fails here. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
).version;

const PINNED_SPEC = `npm:${PI_FLAIR_PACKAGE}@${PKG_VERSION}`;

let isoHome: string;
let prevHome: string | undefined;
let prevPath: string | undefined;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pi-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
  // Detection reads PATH live (binInPath) and piSettingsPath honors
  // PI_CODING_AGENT_DIR — pin both so a host with a real pi install (or a
  // pi dir override) can never leak into these tests.
  prevPath = process.env.PATH;
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPath !== undefined) process.env.PATH = prevPath;
  else delete process.env.PATH;
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(isoHome, { recursive: true, force: true });
});

function userSettingsPath(): string {
  return join(isoHome, ".pi", "agent", "settings.json");
}

function writeUserSettings(config: unknown): string {
  const path = userSettingsPath();
  mkdirSync(join(isoHome, ".pi", "agent"), { recursive: true });
  writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return path;
}

/** Put an executable named `pi` in an isolated dir and make it the whole PATH. */
function fakePiOnPath(): void {
  const binDir = join(isoHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, "pi");
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  process.env.PATH = binDir;
}

// ── registry ────────────────────────────────────────────────────────────────

describe("pi client registration (flair#1342)", () => {
  it("is in the client registry as a native extension with the `pi` bin", () => {
    const pi = ALL_CLIENTS.find((c) => c.id === "pi");
    expect(pi).toBeDefined();
    expect(pi!.bin).toBe("pi");
    expect(pi!.label).toBe("pi");
    // The load-bearing field: every MCP-shaped consumer (doctor's mcpServers
    // loop, the pin machinery, the native-shape fixtures) filters on this.
    expect(pi!.kind).toBe("native-extension");
  });

  it("clientConfigPath resolves to pi's OWN settings, ~/.pi/agent/settings.json", () => {
    expect(clientConfigPath("pi")).toBe(userSettingsPath());
  });

  it("honors pi's PI_CODING_AGENT_DIR override, matching pi's getAgentDir()", () => {
    const custom = join(isoHome, "custom-agent-dir");
    process.env.PI_CODING_AGENT_DIR = custom;
    expect(piSettingsPath()).toBe(join(custom, "settings.json"));
  });

  it("PI_FLAIR_DEFAULT_URL matches pi-flair's own DEFAULT_FLAIR_URL (drift guard)", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "packages", "pi-flair", "src", "index.ts"),
      "utf-8",
    );
    expect(source).toContain(`DEFAULT_FLAIR_URL = "${PI_FLAIR_DEFAULT_URL}"`);
  });
});

// ── detection ───────────────────────────────────────────────────────────────

describe("pi detection: binary on PATH OR settings file (flair#1342)", () => {
  function detectedPi(): boolean {
    return detectClients().find((c) => c.id === "pi")!.detected;
  }

  it("not detected with neither the binary nor a settings file", () => {
    process.env.PATH = join(isoHome, "empty");
    expect(detectedPi()).toBe(false);
  });

  it("detected via the `pi` binary on PATH", () => {
    fakePiOnPath();
    expect(detectedPi()).toBe(true);
  });

  it("detected via ~/.pi/agent/settings.json alone — a configured pi whose bin escapes this shell's PATH is still checkable", () => {
    process.env.PATH = join(isoHome, "empty");
    writeUserSettings({ packages: [] });
    expect(detectedPi()).toBe(true);
  });
});

// ── source / scan helpers ───────────────────────────────────────────────────

describe("pi settings scanning (flair#1342 / #1346)", () => {
  it("recognizes pi-flair npm sources, bare and pinned — and not lookalikes", () => {
    expect(isPiFlairNpmSource(`npm:${PI_FLAIR_PACKAGE}`)).toBe(true);
    expect(isPiFlairNpmSource(`npm:${PI_FLAIR_PACKAGE}@0.48.0`)).toBe(true);
    // Not npm: → not an npm source (it may be a valid PATH entry).
    expect(isPiFlairNpmSource(`${PI_FLAIR_PACKAGE}`)).toBe(false);
    // A different package sharing the prefix must not match.
    expect(isPiFlairNpmSource(`npm:${PI_FLAIR_PACKAGE}-extras`)).toBe(false);
    expect(isPiFlairNpmSource("npm:@tpsdev-ai/flair-mcp@0.48.0")).toBe(false);
  });

  it("extracts the pin from a pinned source and null from a bare one", () => {
    expect(extractPiFlairPin(`npm:${PI_FLAIR_PACKAGE}@0.48.0`)).toBe("0.48.0");
    expect(extractPiFlairPin(`npm:${PI_FLAIR_PACKAGE}`)).toBeNull();
  });

  it("piFlairSpec pins to this checkout's version", () => {
    expect(piFlairSpec()).toBe(PINNED_SPEC);
    expect(piFlairSpec("0.30.0")).toBe(`npm:${PI_FLAIR_PACKAGE}@0.30.0`);
    // The unresolvable-version fallback is bare, never a broken pin.
    expect(piFlairSpec("unknown")).toBe(`npm:${PI_FLAIR_PACKAGE}`);
  });

  it("finds a pinned packages entry (string form)", () => {
    const scan = scanPiSettings(JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}@0.48.0`] }));
    expect(scan.parsed).toBe(true);
    expect(scan.packagesSpec).toBe(`npm:${PI_FLAIR_PACKAGE}@0.48.0`);
    expect(scan.pinnedVersion).toBe("0.48.0");
    expect(scan.misconfiguredNpmUnderExtensions).toEqual([]);
  });

  it("finds a bare packages entry with a null pin", () => {
    const scan = scanPiSettings(JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}`] }));
    expect(scan.packagesSpec).toBe(`npm:${PI_FLAIR_PACKAGE}`);
    expect(scan.pinnedVersion).toBeNull();
  });

  it("finds an object packages entry ({ source, ...filters }) — pi's documented entry shape", () => {
    const scan = scanPiSettings(
      JSON.stringify({ packages: [{ source: `npm:${PI_FLAIR_PACKAGE}@0.48.0`, autoload: false }] }),
    );
    expect(scan.packagesSpec).toBe(`npm:${PI_FLAIR_PACKAGE}@0.48.0`);
    expect(scan.pinnedVersion).toBe("0.48.0");
  });

  it("classifies a file-path extensions entry as the (working) pre-0.49 workaround, not a misconfiguration", () => {
    const scan = scanPiSettings(
      JSON.stringify({ extensions: [`~/.pi/agent/npm/node_modules/${PI_FLAIR_PACKAGE}/dist/index.js`] }),
    );
    expect(scan.extensionFilePaths.length).toBe(1);
    expect(scan.misconfiguredNpmUnderExtensions).toEqual([]);
  });

  // ── the flair#1346 mutation check ─────────────────────────────────────────
  // The detector must fire on the EXACT field failure (npm: under
  // "extensions") and must go quiet when the one thing that is wrong is
  // fixed (the same spec moved to "packages"). A detector that fires on both
  // shapes, or on neither, is a check that cannot fire.

  it("MUTANT: an npm: spec under `extensions` triggers the flair#1346 callout", () => {
    const scan = scanPiSettings(JSON.stringify({ extensions: [`npm:${PI_FLAIR_PACKAGE}`] }));
    expect(scan.misconfiguredNpmUnderExtensions).toEqual([`npm:${PI_FLAIR_PACKAGE}`]);
    // And it is NOT simultaneously counted as working wiring.
    expect(scan.packagesSpec).toBeUndefined();
    expect(scan.extensionFilePaths).toEqual([]);
  });

  it("FIXED: the identical spec under `packages` reads clean", () => {
    const scan = scanPiSettings(JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}`] }));
    expect(scan.misconfiguredNpmUnderExtensions).toEqual([]);
    expect(scan.packagesSpec).toBe(`npm:${PI_FLAIR_PACKAGE}`);
  });

  it("malformed JSON reads as not-parsed, never throws", () => {
    const scan = scanPiSettings("{ this is not json");
    expect(scan.parsed).toBe(false);
    expect(scan.packagesSpec).toBeUndefined();
  });

  it("unrelated packages/extensions entries are ignored", () => {
    const scan = scanPiSettings(
      JSON.stringify({
        packages: ["npm:@some/other-package@1.0.0", { source: "git:github.com/x/y" }],
        extensions: ["./extensions/mine.ts", "npm:@some/other-package"],
      }),
    );
    expect(scan.packagesSpec).toBeUndefined();
    expect(scan.extensionFilePaths).toEqual([]);
    expect(scan.misconfiguredNpmUnderExtensions).toEqual([]);
  });
});

// ── wiring ──────────────────────────────────────────────────────────────────

describe("wirePi — settings.json `packages` with the wireJsonMcp discipline (flair#1342)", () => {
  it("fresh wire: creates the file with a pinned packages entry and an honest env hint", () => {
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.packages).toEqual([PINNED_SPEC]);
    // pi settings carry no env block — the message must put the launch-env
    // burden where it lives instead of implying the wiring carried it.
    expect(res.message).toContain("export FLAIR_AGENT_ID=wirebot");
    // And never the MCP clients' confident restart claim.
    expect(res.message).not.toContain("restart");
  });

  it("is idempotent: second run is a byte-identical no-op", () => {
    wirePi(ENV);
    const before = readFileSync(userSettingsPath(), "utf-8");
    const second = wirePi(ENV);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("already wired");
    expect(readFileSync(userSettingsPath(), "utf-8")).toBe(before);
  });

  it("preserves sibling keys and other packages entries", () => {
    writeUserSettings({
      theme: "dark",
      packages: ["npm:@some/other-package@1.0.0"],
      extensions: ["./extensions/mine.ts"],
    });
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.packages).toEqual(["npm:@some/other-package@1.0.0", PINNED_SPEC]);
    expect(cfg.extensions).toEqual(["./extensions/mine.ts"]);
  });

  it("refreshes a stale pin (flair#1135 discipline)", () => {
    writeUserSettings({ packages: [`npm:${PI_FLAIR_PACKAGE}@0.1.0`] });
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("refreshed pin");
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.packages).toEqual([PINNED_SPEC]);
  });

  it("refreshes an object entry's source in place, preserving its filters", () => {
    writeUserSettings({ packages: [{ source: `npm:${PI_FLAIR_PACKAGE}@0.1.0`, autoload: false }] });
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.packages).toEqual([{ source: PINNED_SPEC, autoload: false }]);
  });

  it("MOVES an npm: spec out of `extensions` into `packages` — the flair#1346 fix, named", () => {
    writeUserSettings({ extensions: [`npm:${PI_FLAIR_PACKAGE}`, "./extensions/mine.ts"] });
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("flair#1346");
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    // The decoy is gone, the sibling survives, packages carries the pin.
    expect(cfg.extensions).toEqual(["./extensions/mine.ts"]);
    expect(cfg.packages).toEqual([PINNED_SPEC]);
    // And the post-fix state reads clean + wired — the wire-side twin of the
    // scanner mutation check above.
    const after = checkPiFlairWiring(isoHome);
    expect(after.misconfigured).toEqual([]);
    expect(after.wired).toBe(true);
    expect(after.wiredVia).toBe("packages");
  });

  it("honors a WORKING file-path extensions entry as already wired (pre-0.49 workaround), touching nothing", () => {
    const extFile = join(isoHome, "pi-flair-dist", "index.js");
    mkdirSync(join(isoHome, "pi-flair-dist"), { recursive: true });
    writeFileSync(extFile, "// pi-flair build\n");
    writeUserSettings({ extensions: [extFile] });
    const before = readFileSync(userSettingsPath(), "utf-8");
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("file-path extension");
    expect(res.message).toContain("packages");
    expect(readFileSync(userSettingsPath(), "utf-8")).toBe(before);
  });

  it("a DANGLING file-path entry is not treated as wired — wires packages alongside it", () => {
    writeUserSettings({ extensions: [join(isoHome, "gone", "pi-flair", "index.js")] });
    const res = wirePi(ENV);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.packages).toEqual([PINNED_SPEC]);
  });

  it("refuses malformed JSON with the manual snippet — never clobbers", () => {
    writeUserSettings("{ broken");
    const res = wirePi(ENV);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("manual wiring needed");
    expect(res.message).toContain(`"${PINNED_SPEC}"`);
    // Original bytes intact.
    expect(readFileSync(userSettingsPath(), "utf-8")).toBe("{ broken");
  });

  it("refuses a non-array `packages` key — never rewrites a shape it does not understand", () => {
    writeUserSettings({ packages: { weird: true } });
    const res = wirePi(ENV);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("manual wiring needed");
    const cfg = JSON.parse(readFileSync(userSettingsPath(), "utf-8"));
    expect(cfg.packages).toEqual({ weird: true });
  });
});

// ── doctor's wiring check ───────────────────────────────────────────────────

describe("checkPiFlairWiring — what doctor reports for pi (flair#1342)", () => {
  it("round-trips wirePi output: wired via packages, current pin", () => {
    wirePi(ENV);
    const report = checkPiFlairWiring(isoHome);
    expect(report.wired).toBe(true);
    expect(report.wiredVia).toBe("packages");
    expect(report.wiredIn).toBe(userSettingsPath());
    expect(report.pinnedVersion).toBe(PKG_VERSION);
    expect(report.misconfigured).toEqual([]);
  });

  it("no settings anywhere: not wired, and the checked paths are named", () => {
    const report = checkPiFlairWiring(isoHome);
    expect(report.wired).toBe(false);
    expect(report.settingsPath).toBe(userSettingsPath());
    expect(report.checked).toEqual([{ path: userSettingsPath(), exists: false }]);
  });

  it("flags the flair#1346 trap with file and entry — and does NOT report it as wired", () => {
    const path = writeUserSettings({ extensions: [`npm:${PI_FLAIR_PACKAGE}@0.48.0`] });
    const report = checkPiFlairWiring(isoHome);
    expect(report.misconfigured).toEqual([{ path, entry: `npm:${PI_FLAIR_PACKAGE}@0.48.0` }]);
    expect(report.wired).toBe(false);
  });

  it("a correct packages entry does not launder a coexisting extensions decoy — both are reported", () => {
    writeUserSettings({
      packages: [PINNED_SPEC],
      extensions: [`npm:${PI_FLAIR_PACKAGE}`],
    });
    const report = checkPiFlairWiring(isoHome);
    expect(report.wired).toBe(true);
    expect(report.wiredVia).toBe("packages");
    expect(report.misconfigured.length).toBe(1);
  });

  it("extension-path wiring: reports whether the file actually exists", () => {
    const extFile = join(isoHome, "pi-flair-dist", "index.js");
    mkdirSync(join(isoHome, "pi-flair-dist"), { recursive: true });
    writeFileSync(extFile, "// build\n");
    writeUserSettings({ extensions: [extFile] });
    const wired = checkPiFlairWiring(isoHome);
    expect(wired.wiredVia).toBe("extension-path");
    expect(wired.extensionPathExists).toBe(true);

    rmSync(extFile);
    const dangling = checkPiFlairWiring(isoHome);
    expect(dangling.wiredVia).toBe("extension-path");
    expect(dangling.extensionPathExists).toBe(false);
  });

  it("resolves a ~/ extension path against the given home", () => {
    mkdirSync(join(isoHome, "dist"), { recursive: true });
    writeFileSync(join(isoHome, "dist", "pi-flair.js"), "// build\n");
    writeUserSettings({ extensions: ["~/dist/pi-flair.js"] });
    const report = checkPiFlairWiring(isoHome);
    expect(report.wiredVia).toBe("extension-path");
    expect(report.extensionPathExists).toBe(true);
  });

  it("project-scope .pi/settings.json wires too (pi merges both scopes)", () => {
    const project = join(isoHome, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ packages: [PINNED_SPEC] }));
    const report = checkPiFlairWiring(isoHome, project);
    expect(report.wired).toBe(true);
    expect(report.wiredIn).toBe(join(project, ".pi", "settings.json"));
    expect(report.checked.length).toBe(2);
  });

  it("a malformed settings file reads as not wired, never a throw", () => {
    writeUserSettings("not json at all");
    const report = checkPiFlairWiring(isoHome);
    expect(report.wired).toBe(false);
    expect(report.checked[0]!.exists).toBe(true);
  });
});
