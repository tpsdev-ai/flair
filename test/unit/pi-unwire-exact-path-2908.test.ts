// pi-unwire-exact-path-2908.test.ts — flair#2908.
//
// Unwiring pi dropped every `extensions` entry whose string merely CONTAINED
// "pi-flair". That substring heuristic exists so doctor can NAME the entry it
// matched; using it to decide a removal meant a user file such as
// ~/dist/pi-flair-notes.js was deleted from the user's own settings. Removal
// now follows the entry Flair writes: an npm pi-flair spec, or a path with a
// whole `pi-flair` segment.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALL_CLIENTS,
  PI_FLAIR_PACKAGE,
  isInsidePiFlairPackage,
  piSettingsPath,
} from "../../src/install/clients.ts";
import { withHome } from "../../src/lib/home.ts";

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;

// The file-path wiring Flair documents for pre-0.49 pi: a path INSIDE the
// installed package.
const FLAIR_ENTRY = "~/.pi/agent/npm/node_modules/@tpsdev-ai/pi-flair/dist/index.js";
// A user file that only carries the name.
const LOOKALIKE = "~/dist/pi-flair-notes.js";
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

describe("pi unwire — only the entry Flair writes", () => {
  it("removes Flair's own entry; the lookalike and the unrelated extension survive byte-identical", () => {
    const path = writePiSettings({
      extensions: [FLAIR_ENTRY, LOOKALIKE, OTHER],
      packages: [`npm:${PI_FLAIR_PACKAGE}`],
    });
    const before = JSON.parse(readFileSync(path, "utf-8"));
    expect(before.extensions).toEqual([FLAIR_ENTRY, LOOKALIKE, OTHER]);

    const res = withHome(isoHome, () => piClient.unwire());

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(true);
    expect(after.extensions).toHaveLength(2);
    expect(after.extensions[0]).toBe(before.extensions[1]);
    expect(after.extensions[1]).toBe(before.extensions[2]);
    expect(after.extensions).toEqual([LOOKALIKE, OTHER]);
    expect(after.packages).toEqual([]);
    // The entry it kept is named in the unwire result.
    expect(res.message).toContain(LOOKALIKE);
  });

  it("leaves the file untouched and names the lookalike when there is no Flair entry", () => {
    const path = writePiSettings({ extensions: [LOOKALIKE, OTHER] });
    const before = readFileSync(path, "utf-8");

    const res = withHome(isoHome, () => piClient.unwire());

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(res.message).toContain(LOOKALIKE);
  });

  it("matches a whole `pi-flair` path segment, not a substring of the file name", () => {
    expect(isInsidePiFlairPackage(FLAIR_ENTRY)).toBe(true);
    expect(isInsidePiFlairPackage("C:\\Users\\agent\\.pi\\agent\\npm\\node_modules\\@tpsdev-ai\\pi-flair\\dist\\index.js")).toBe(true);
    expect(isInsidePiFlairPackage(LOOKALIKE)).toBe(false);
    expect(isInsidePiFlairPackage("~/dist/my-pi-flair-notes.js")).toBe(false);
  });
});
