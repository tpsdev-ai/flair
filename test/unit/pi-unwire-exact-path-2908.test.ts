import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALL_CLIENTS,
  PI_FLAIR_PACKAGE,
  isFlairOwnedPiEntry,
  isPiFlairNpmSource,
  piSettingsPath,
} from "../../src/install/clients.ts";
import { purgeFlairInstall, formatPurgeReport } from "../../src/lib/uninstall-purge.ts";
import { withHome } from "../../src/lib/home.ts";

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;

// The documented extension path.
const FLAIR_ENTRY = "~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/dist/index.js";
// User entries that only carry the name, in three shapes.
const WORK_LOOKALIKE = "~/work/pi-flair/notes.js";
const NPM_LOOKALIKE = "npm:@other/pi-flair";
const NAME_LOOKALIKE = "~/dist/pi-flair-notes.js";
const LOOKALIKES = [WORK_LOOKALIKE, NPM_LOOKALIKE, NAME_LOOKALIKE];
// An unrelated extension source.
const OTHER = "npm:@acme/pi-tools@2.1.0";

let isoHome: string;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pi-unwire-"));
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(isoHome, { recursive: true, force: true });
});

function writePiSettings(config: unknown): string {
  const path = withHome(isoHome, () => piSettingsPath());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

describe("pi unwire ownership", () => {
  it("removes Flair's own npm spec and package path; each lookalike survives and is reported", () => {
    const path = writePiSettings({
      extensions: [FLAIR_ENTRY, WORK_LOOKALIKE, NAME_LOOKALIKE, OTHER],
      packages: [`npm:${PI_FLAIR_PACKAGE}@0.50.0`, NPM_LOOKALIKE],
    });
    const before = JSON.parse(readFileSync(path, "utf-8"));
    expect(before.extensions).toEqual([FLAIR_ENTRY, WORK_LOOKALIKE, NAME_LOOKALIKE, OTHER]);
    expect(before.packages).toEqual([`npm:${PI_FLAIR_PACKAGE}@0.50.0`, NPM_LOOKALIKE]);

    const res = withHome(isoHome, () => piClient.unwire());

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(true);
    expect(after.extensions).toEqual([WORK_LOOKALIKE, NAME_LOOKALIKE, OTHER]);
    expect(after.packages).toEqual([NPM_LOOKALIKE]);
    for (const position of ["packages[1]", "extensions[1]", "extensions[2]"]) expect(res.message).toContain(position);
    for (const source of [FLAIR_ENTRY, ...LOOKALIKES]) expect(JSON.stringify(res)).not.toContain(source);
  });

  it("leaves the file untouched and reports lookalike positions when there is no Flair entry", () => {
    const path = writePiSettings({ extensions: [WORK_LOOKALIKE, NAME_LOOKALIKE, OTHER], packages: [NPM_LOOKALIKE] });
    const before = readFileSync(path, "utf-8");

    const res = withHome(isoHome, () => piClient.unwire());

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
    for (const position of ["packages[0]", "extensions[0]", "extensions[1]"]) expect(res.message).toContain(position);
    for (const source of LOOKALIKES) expect(JSON.stringify(res)).not.toContain(source);
  });

  it("matches canonical npm sources and lexical package-path segments", () => {
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}`)).toBe(true);
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}@0.50.0`)).toBe(true);
    expect(isFlairOwnedPiEntry(FLAIR_ENTRY)).toBe(true);
    expect(isFlairOwnedPiEntry("~/node_modules/@tpsdev-ai/pi-flair/../../../notes.js")).toBe(true);
    expect(
      isFlairOwnedPiEntry("C:\\Users\\agent\\.pi\\agent\\npm\\node_modules\\@tpsdev-ai\\pi-flair\\dist\\index.js"),
    ).toBe(true);
    for (const lookalike of LOOKALIKES) expect(isFlairOwnedPiEntry(lookalike)).toBe(false);
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}-extras`)).toBe(false);
    expect(isFlairOwnedPiEntry("~/node_modules/@tpsdev-ai/pi-flair")).toBe(false);
  });

  for (const changed of [true, false]) {
    it(`preserves whitespace-containing and empty-suffix npm sources and reports positions on the ${changed ? "changed" : "no-op"} path`, () => {
      const retained = [
        "npm: @tpsdev-ai/pi-flair", "npm:@tpsdev-ai/pi-flair ", "npm:@tpsdev-ai/pi-flair@",
        "npm:@tpsdev-ai/pi-flair@ leading", "npm:@tpsdev-ai/pi-flair@1.0 x",
      ];
      const owned = [`npm:${PI_FLAIR_PACKAGE}`, `npm:${PI_FLAIR_PACKAGE}@latest`];
      const entries = changed ? [...retained, ...owned] : retained;
      const path = writePiSettings({ packages: entries.map(source => ({ source })), extensions: entries });
      const before = readFileSync(path, "utf-8");
      const res = withHome(isoHome, () => piClient.unwire());
      expect(res.ok).toBe(true);
      expect(res.removed).toBe(changed);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ packages: retained.map(source => ({ source })), extensions: retained });
      if (!changed) expect(readFileSync(path, "utf-8")).toBe(before);
      for (const [index, source] of retained.entries()) {
        expect(isPiFlairNpmSource(source)).toBe(false);
        expect(isFlairOwnedPiEntry(source)).toBe(false);
        expect(res.message).toContain(`packages[${index}]`);
        expect(res.message).toContain(`extensions[${index}]`);
      }
      for (const source of owned) {
        expect(isPiFlairNpmSource(source)).toBe(true);
        expect(isFlairOwnedPiEntry(source)).toBe(true);
      }
    });

    it(`omits source values from complete unwire and purge output on the ${changed ? "changed" : "no-op"} path`, () => {
      const sources = [
        "git:https://fixture-user:fixture-password@example.test/pi-flair",
        "https://fixture-user:fixture-password@example.test/pi-flair",
      ];
      const owned = `npm:${PI_FLAIR_PACKAGE}@fixture-secret`;
      const entries = changed ? [...sources, owned] : sources;
      const config = { packages: entries.map(source => ({ source })), extensions: entries };
      const path = writePiSettings(config);
      const res = withHome(isoHome, () => piClient.unwire());
      expect(res.ok).toBe(true);
      expect(res.removed).toBe(changed);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ packages: sources.map(source => ({ source })), extensions: sources });
      for (const position of ["packages[0]", "packages[1]", "extensions[0]", "extensions[1]"]) expect(res.message).toContain(position);
      if (changed) {
        expect(res.message).toContain("removed packages[2], extensions[2]");
      }
      writePiSettings(config);
      const purge = purgeFlairInstall({ homeDir: isoHome, skipSchedulerUnload: true, omitNpmLeftover: true });
      const report = formatPurgeReport(purge);
      if (changed) expect(report.lines.join("\n")).toContain("removed packages[2], extensions[2]");
      const output = JSON.stringify({ res, purge, report });
      for (const secret of [...entries, "fixture-user", "fixture-password", "fixture-secret"]) expect(output).not.toContain(secret);
    });
  }

});
