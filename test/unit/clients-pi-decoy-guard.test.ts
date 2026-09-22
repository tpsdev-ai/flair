// clients-pi-decoy-guard.test.ts — flair#1778 slice 2c-i-a3, the pi decoy case.
//
// Both #1812 reviewers noted this one as uncovered: when a `packages` entry
// EXISTS and a HIGHER misplaced `npm:` source sits under `extensions`, the old
// pi writer consulted only the packages entry and DROPPED the extension pin on
// the floor — the move would lower a pin the user had written. The writer now
// decides on BOTH: the highest comparable governs and any non-comparable holds,
// so a hold/refuse leaves BOTH arrays byte-identical.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_CLIENTS, PI_FLAIR_PACKAGE, piSettingsPath } from "../../src/install/clients.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

const ENV = { FLAIR_AGENT_ID: "pibot", FLAIR_URL: "http://127.0.0.1:19926" };
const RUN = flairCliVersion();
const RUNNING = `npm:${PI_FLAIR_PACKAGE}@${RUN}`;
const AHEAD = `npm:${PI_FLAIR_PACKAGE}@9.9.9`;
const BEHIND = `npm:${PI_FLAIR_PACKAGE}@0.0.1`;

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;

let isoHome: string;
let prevHome: string | undefined;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pi-decoy-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(isoHome, { recursive: true, force: true });
});

function writePiSettings(config: unknown): string {
  const path = piSettingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

const read = (path: string): any => JSON.parse(readFileSync(path, "utf-8"));

describe("pi decoy — packages present AND a higher misplaced extensions source", () => {
  it("{extensions:[@9.9.9], packages:[@0.0.1]} → HELD, both arrays byte-identical", () => {
    const path = writePiSettings({ extensions: [AHEAD], packages: [BEHIND] });
    const before = readFileSync(path, "utf-8");
    // (10) the fixture genuinely set both fields:
    expect(read(path).extensions).toContain(AHEAD);
    expect(read(path).packages).toContain(BEHIND);

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("9.9.9");
    expect(readFileSync(path, "utf-8")).toBe(before); // BOTH arrays untouched
    expect(read(path).extensions).toContain(AHEAD);
    expect(read(path).packages).toContain(BEHIND);
  });

  it("{extensions:[@^0.55.0], packages:[@0.0.1]} → HELD (a non-comparable source holds) — on main the extension is dropped", () => {
    const range = `npm:${PI_FLAIR_PACKAGE}@^0.55.0`;
    const path = writePiSettings({ extensions: [range], packages: [BEHIND] });
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("{extensions:[@0.0.1], packages:[@0.0.2]} → both writable, MOVED + repinned UP (positive control)", () => {
    const path = writePiSettings({ extensions: [BEHIND], packages: [`npm:${PI_FLAIR_PACKAGE}@0.0.2`] });

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(read(path).extensions).toEqual([]); // the misplaced source is moved out
    expect(read(path).packages).toEqual([RUNNING]); // single running pin
  });
});
