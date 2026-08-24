// flair#1385 — engines.node must not admit a Node Harper refuses.
//
// Flair declared `>=22`. Harper 5.2 declares `^22.18.0 || >=24`. The whole
// band Node 22.0–22.17 (and every 23.x) satisfied our field and failed
// Harper's. npm's engines check — the mechanism that exists to stop this —
// passed, because we told it to. Then `flair init` installed Harper and
// Harper refused on its own engines check. The user did nothing wrong.
//
// The floor is DERIVED from the installed harper/package.json. A hardcoded
// second copy of Harper's range is a new thing to drift — Harper's floor
// moved once and will move again, and nothing currently notices.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

type Triple = [number, number, number];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function enginesOf(pkg: Record<string, unknown>): { node?: unknown } | undefined {
  const engines = pkg.engines;
  if (!engines || typeof engines !== "object") return undefined;
  return engines as { node?: unknown };
}

/** Same resolution order as readInstalledHarperVersion — the Harper we embed.
 *  Filesystem lookup, not require.resolve: Harper's exports map does not
 *  expose `./package.json`. */
function installedHarperPkgPath(): string {
  for (const name of ["harper", "@harperfast/harper"]) {
    const pkgPath = join(REPO_ROOT, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(pkgPath)) return pkgPath;
  }
  throw new Error(
    "installed harper/package.json not found; cannot derive Harper's engines.node floor",
  );
}

function readNodeRange(pkg: Record<string, unknown>, label: string): string {
  const range = enginesOf(pkg)?.node;
  if (typeof range !== "string" || !range.trim()) {
    throw new Error(`${label} has no engines.node; cannot compare Node floors`);
  }
  return range.trim();
}

function parseTriple(raw: string): Triple | null {
  const m = raw.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: Triple, b: Triple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function satisfiesComparator(version: Triple, comparator: string): boolean {
  const c = comparator.trim();
  if (!c) return true;
  if (c.startsWith("^")) {
    const base = parseTriple(c.slice(1));
    if (!base) return false;
    const upper: Triple =
      base[0] > 0 ? [base[0] + 1, 0, 0] :
      base[1] > 0 ? [0, base[1] + 1, 0] :
      [0, 0, base[2] + 1];
    return cmp(version, base) >= 0 && cmp(version, upper) < 0;
  }
  const opMatch = c.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!opMatch) return false;
  const op = opMatch[1] || "=";
  const base = parseTriple(opMatch[2]);
  if (!base) return false;
  const d = cmp(version, base);
  if (op === ">=") return d >= 0;
  if (op === "<=") return d <= 0;
  if (op === ">") return d > 0;
  if (op === "<") return d < 0;
  return d === 0;
}

/** npm-engines ranges: `||` unions, whitespace-separated AND comparators. */
function satisfiesRange(version: string, range: string): boolean {
  const v = parseTriple(version);
  if (!v) return false;
  return range.split("||").some((group) => {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => satisfiesComparator(v, p));
  });
}

function formatVersion(v: Triple): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/** Versions mentioned in either range, plus the neighbors that expose a gap. */
function probeVersions(flairRange: string, harperRange: string): string[] {
  const mentioned = [...`${flairRange} ${harperRange}`.matchAll(/\d+(?:\.\d+){0,2}/g)]
    .map((m) => parseTriple(m[0]))
    .filter((v): v is Triple => v !== null);
  const probes = new Set<string>();
  const add = (v: Triple) => {
    if (v[0] >= 0 && v[1] >= 0 && v[2] >= 0) probes.add(formatVersion(v));
  };
  for (const [maj, min, pat] of mentioned) {
    add([maj, min, pat]);
    add([maj, min, Math.max(0, pat - 1)]);
    add([maj, min, pat + 1]);
    add([maj, Math.max(0, min - 1), 0]);
    add([maj, min + 1, 0]);
    add([Math.max(0, maj - 1), 0, 0]);
    add([maj + 1, 0, 0]);
    add([maj, 0, 0]);
  }
  const majors = mentioned.map((v) => v[0]);
  const lo = Math.max(0, Math.min(...majors, 22) - 1);
  const hi = Math.max(...majors, 24) + 2;
  for (let maj = lo; maj <= hi; maj++) {
    for (const min of [0, 1, 17, 18, 19, 20, 99]) {
      add([maj, min, 0]);
    }
  }
  return [...probes];
}

function versionsAdmittedThatOtherRejects(flairRange: string, harperRange: string): string[] {
  return probeVersions(flairRange, harperRange).filter(
    (v) => satisfiesRange(v, flairRange) && !satisfiesRange(v, harperRange),
  );
}

/** Null when flair's range is a subset of Harper's. Otherwise a message naming both. */
function admissionFailure(flairRange: string, harperRange: string): string | null {
  const offenders = versionsAdmittedThatOtherRejects(flairRange, harperRange);
  if (offenders.length === 0) return null;
  return (
    `flair engines.node ${JSON.stringify(flairRange)} admits versions Harper rejects ` +
    `(${JSON.stringify(harperRange)}); e.g. ${offenders.sort()[0]}`
  );
}

describe("the range comparator (positive control)", () => {
  test("Harper's caret+OR shape accepts 22.18 and 24, rejects 22.17 and 23", () => {
    // A canned Harper-shaped range — not the live value. Proves the comparator
    // itself can see the gap this bug lives in, so a green live-package test
    // is not a comparator that never fails.
    const harperShaped = "^22.18.0 || >=24.0.0";
    expect(satisfiesRange("22.17.0", harperShaped)).toBe(false);
    expect(satisfiesRange("22.18.0", harperShaped)).toBe(true);
    expect(satisfiesRange("23.0.0", harperShaped)).toBe(false);
    expect(satisfiesRange("24.0.0", harperShaped)).toBe(true);
    expect(satisfiesRange("22.0.0", ">=22")).toBe(true);
  });

  test(">=22 against a Harper-shaped floor names both ranges", () => {
    const harperShaped = "^22.18.0 || >=24.0.0";
    const failure = admissionFailure(">=22", harperShaped);
    expect(failure).not.toBeNull();
    expect(failure!).toContain(">=22");
    expect(failure!).toContain(harperShaped);
  });
});

describe("flair engines.node vs installed Harper (flair#1385)", () => {
  test("the floor is read from installed harper/package.json, not a literal in this file", () => {
    const harperPath = installedHarperPkgPath();
    const harper = readJson(harperPath);
    const range = readNodeRange(harper, `installed ${harperPath}`);
    // Presence + type only. Asserting a specific string here would be the
    // hardcoded second copy this test exists to avoid.
    expect(range.length).toBeGreaterThan(0);
    expect(harperPath).toMatch(/node_modules/);
  });

  test("flair admits no version Harper rejects — failure names both ranges", () => {
    const flairRange = readNodeRange(readJson(join(REPO_ROOT, "package.json")), "flair package.json");
    const harperPath = installedHarperPkgPath();
    const harperRange = readNodeRange(readJson(harperPath), `installed ${harperPath}`);
    const failure = admissionFailure(flairRange, harperRange);
    expect(failure).toBeNull();
  });

  test("the previously-shipped >=22 range is a superset of the installed Harper floor", () => {
    // Powered shape: if this ever goes green, either Harper loosened to
    // admit all of >=22 (then our engines can follow) or the comparator
    // stopped seeing the gap. The live-package test above is the one that
    // fails when someone widens flair's field back to >=22.
    const harperPath = installedHarperPkgPath();
    const harperRange = readNodeRange(readJson(harperPath), `installed ${harperPath}`);
    const failure = admissionFailure(">=22", harperRange);
    expect(failure).not.toBeNull();
    expect(failure!).toContain(">=22");
    expect(failure!).toContain(harperRange);
  });
});
