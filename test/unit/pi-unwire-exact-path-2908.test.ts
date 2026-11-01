// pi-unwire-exact-path-2908.test.ts — flair#2908.
//
// Unwiring pi dropped every `extensions` entry whose string merely CONTAINED
// "pi-flair", and matched a path with any `pi-flair` segment. That substring
// heuristic exists so doctor can NAME the entry it matched; using it to decide
// a removal meant a user file such as ~/dist/pi-flair-notes.js or
// ~/work/pi-flair/notes.js was deleted from the user's own settings. Removal
// now follows the entry Flair writes: the npm spec
// `npm:@tpsdev-ai/pi-flair[@<spec>]`, or a path with the consecutive segments
// `node_modules/@tpsdev-ai/pi-flair/`.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ALL_CLIENTS,
  PI_FLAIR_PACKAGE,
  isFlairOwnedPiEntry,
  piSettingsPath,
} from "../../src/install/clients.ts";
import { withHome } from "../../src/lib/home.ts";

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;

// The file-path wiring Flair documents for pre-0.49 pi: a path INSIDE the
// installed package.
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

describe("pi unwire — only the entry Flair writes", () => {
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
    for (const lookalike of LOOKALIKES) expect(res.message).toContain(lookalike);
  });

  it("leaves the file untouched and names each lookalike when there is no Flair entry", () => {
    const path = writePiSettings({ extensions: [WORK_LOOKALIKE, NAME_LOOKALIKE, OTHER], packages: [NPM_LOOKALIKE] });
    const before = readFileSync(path, "utf-8");

    const res = withHome(isoHome, () => piClient.unwire());

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
    for (const lookalike of LOOKALIKES) expect(res.message).toContain(lookalike);
  });

  it("accepts only the exact npm spec and the installed package path", () => {
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}`)).toBe(true);
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}@0.50.0`)).toBe(true);
    expect(isFlairOwnedPiEntry(FLAIR_ENTRY)).toBe(true);
    expect(
      isFlairOwnedPiEntry("C:\\Users\\agent\\.pi\\agent\\npm\\node_modules\\@tpsdev-ai\\pi-flair\\dist\\index.js"),
    ).toBe(true);
    for (const lookalike of LOOKALIKES) expect(isFlairOwnedPiEntry(lookalike)).toBe(false);
    expect(isFlairOwnedPiEntry(`npm:${PI_FLAIR_PACKAGE}-extras`)).toBe(false);
    expect(isFlairOwnedPiEntry("~/node_modules/@tpsdev-ai/pi-flair")).toBe(false);
  });
});
