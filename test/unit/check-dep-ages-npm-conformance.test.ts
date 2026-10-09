/**
 * test/unit/check-dep-ages-npm-conformance.test.ts — the bake-time gate's
 * `overrides` classification (classifyOverrides in
 * scripts/lib/check-dep-ages-collect.mjs) checked against npm's own reading of
 * the same inputs.
 *
 * npm's reading is a VENDORED RECORDING, not a live call: this repo has no npm
 * dependency, so test/fixtures/dep-ages-npm-overrides/record.cjs ran npm's own
 * OverrideSet (@npmcli/arborist) and npm-package-arg over every case and saved
 * the result in npm-overrides.json, with the versions it used. The test is
 * offline and hermetic.
 *
 * For every rule npm derives, the gate must either refuse it (or an enclosing
 * rule), or agree with npm: a rule npm reads as an exact version is classified
 * exact under the same name and version; a range is not classified exact; a
 * rule that overrides nothing pins nothing. The gate may not add a rule npm
 * does not derive.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyOverrides, type OverrideRule } from "../../scripts/lib/check-dep-ages-collect.mjs";

interface NpmParsed {
  type: string;
  version?: string;
  target?: string;
  targetType?: string;
  error?: string;
}
interface NpmRule {
  path: string[];
  name: string;
  keySpec: string;
  value: string | null;
  parsed: NpmParsed;
}
interface ConformanceCase {
  name: string;
  overrides: unknown;
  npm: { rules?: NpmRule[]; error?: string };
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/dep-ages-npm-overrides/npm-overrides.json", import.meta.url), "utf8"),
) as { recordedWith: Record<string, string>; cases: ConformanceCase[] };

const pathKey = (path: string[]) => JSON.stringify(path);

/** The gate's kinds npm's reading of a rule allows; "refused" is always allowed. */
function allowedKinds(rule: NpmRule): OverrideRule["kind"][] {
  const { type, targetType } = rule.parsed;
  const effective = type === "alias" ? targetType : type;
  switch (effective) {
    case "version":
      return ["exact", "refused"];
    case "range":
      return ["range", "refused"];
    case "no-override":
      return ["none", "refused"];
    case "git":
    case "file":
    case "directory":
      return ["exempt", "refused"];
    case "error":
      // workspace: and link: are bun forms npm rejects; the gate exempts them
      // like the dependencies fields do (they name no registry version).
      return /^(?:workspace|link):/.test(rule.value ?? "") ? ["exempt", "refused"] : ["refused"];
    default:
      // tag, remote, reference, not-a-string
      return ["refused"];
  }
}

/** The gate's reading of every case, as "path kind[ name@version]" lines. */
const EXPECTED: Record<string, string[]> = {
  "exact version": ['["fixture-dep"] exact fixture-dep@1.0.0'],
  "exact prerelease": ['["fixture-dep"] exact fixture-dep@1.0.0-beta.1'],
  "exact with build metadata": ['["fixture-dep"] refused'],
  "v-prefixed version": ['["fixture-dep"] refused'],
  "=-prefixed version": ['["fixture-dep"] refused'],
  "leading-zero version": ['["fixture-dep"] refused'],
  "caret range": ['["fixture-dep"] range'],
  "tilde range": ['["fixture-dep"] range'],
  "x-range": ['["fixture-dep"] range'],
  "major-only range": ['["fixture-dep"] range'],
  "major.minor range": ['["fixture-dep"] range'],
  "hyphen range": ['["fixture-dep"] range'],
  "or-range of versions": ['["fixture-dep"] range'],
  "comparator pair": ['["fixture-dep"] range'],
  "operator with a space": ['["fixture-dep"] range'],
  star: ['["fixture-dep"] none'],
  "empty string": ['["fixture-dep"] none'],
  "dist-tag": ['["fixture-dep"] refused'],
  "alias to an exact version": ['["fixture-dep"] exact other-dep@2.0.0'],
  "alias to a range": ['["fixture-dep"] range'],
  "alias to a scoped package": ['["fixture-dep"] exact @scope/other-dep@2.0.0'],
  "alias with no version": ['["fixture-dep"] range'],
  "alias of the same package": ['["fixture-dep"] exact fixture-dep@1.0.0'],
  "alias to a dist-tag": ['["fixture-dep"] refused'],
  "dollar reference": ['["fixture-dep"] refused'],
  "file specifier": ['["fixture-dep"] exempt'],
  "github specifier": ['["fixture-dep"] exempt'],
  "git+https specifier": ['["fixture-dep"] exempt'],
  "tarball URL": ['["fixture-dep"] refused'],
  "hosted git shorthand": ['["fixture-dep"] refused'],
  "workspace protocol": ['["fixture-dep"] exempt'],
  "link protocol": ['["fixture-dep"] exempt'],
  "nested pin under a parent": ['["parent-dep"] none', '["parent-dep","fixture-dep"] exact fixture-dep@1.0.0'],
  "self key": ['["fixture-dep"] exact fixture-dep@1.0.0'],
  "self key with a nested range": ['["parent-dep"] exact parent-dep@3.0.0', '["parent-dep","fixture-dep"] range'],
  "two levels deep": [
    '["a-dep"] none',
    '["a-dep","b-dep"] none',
    '["a-dep","b-dep","fixture-dep"] exact fixture-dep@1.0.0',
  ],
  "empty self key": ['["fixture-dep"] none'],
  "selector key with an exact value": ['["fixture-dep@^1"] exact fixture-dep@1.0.0'],
  "scoped selector key": ['["@scope/fixture-dep@^1"] exact @scope/fixture-dep@1.0.0'],
  "scoped key": ['["@scope/fixture-dep"] exact @scope/fixture-dep@1.0.0'],
  "range selector on a parent object": ['["fixture-dep@1.x"] range', '["fixture-dep@1.x","child-dep"] exact child-dep@2.0.0'],
  "exact selector on a parent object": [
    '["fixture-dep@1.0.0"] exact fixture-dep@1.0.0',
    '["fixture-dep@1.0.0","child-dep"] exact child-dep@2.0.0',
  ],
  "URL key": ['["https://example.com/x"] refused'],
  "path-shaped key": ['["owner-a/repo-a"] refused'],
  "number value": ['["fixture-dep"] refused'],
  "null value": ['["fixture-dep"] refused'],
  "array value": ['["fixture-dep"] refused'],
  "self key at the top level": ['["."] refused'],
  "non-string self key": ['["fixture-dep"] refused'],
  "overrides is a string": ["[] refused"],
};

function summarize(rule: OverrideRule): string {
  const head = `${pathKey(rule.path)} ${rule.kind}`;
  return rule.kind === "exact" ? `${head} ${rule.name}@${rule.version}` : head;
}

describe("override classification conforms to npm's recorded reading", () => {
  it("the recording names the npm modules it came from and covers every expected case", () => {
    for (const pkg of ["npm", "@npmcli/arborist", "npm-package-arg", "semver"]) {
      expect(FIXTURE.recordedWith[pkg]).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(FIXTURE.cases.map((c) => c.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const ours = classifyOverrides(structuredClone(c.overrides));
      expect(ours.map(summarize)).toEqual(EXPECTED[c.name]);

      const byPath = new Map(ours.map((r) => [pathKey(r.path), r]));
      const refusedAt = (path: string[]) =>
        ours.some((r) => r.kind === "refused" && pathKey(path.slice(0, r.path.length)) === pathKey(r.path));

      if (c.npm.error !== undefined) {
        // npm cannot read this `overrides` value at all; the gate must refuse it.
        expect(ours.some((r) => r.kind === "refused")).toBe(true);
        return;
      }
      const npmRules = c.npm.rules ?? [];
      for (const rule of npmRules) {
        const mine = byPath.get(pathKey(rule.path));
        if (!mine) {
          // Only a refused enclosing rule may leave an npm rule unread.
          expect(refusedAt(rule.path)).toBe(true);
          continue;
        }
        expect(allowedKinds(rule)).toContain(mine.kind);
        if (mine.kind === "exact") {
          expect(mine.name).toBe(rule.parsed.type === "alias" ? rule.parsed.target! : rule.name);
          expect(mine.version).toBe(rule.parsed.version!);
        }
      }
      // The gate reads no rule npm does not derive.
      const npmPaths = new Set(npmRules.map((r) => pathKey(r.path)));
      for (const r of ours) {
        if (r.kind !== "refused") expect(npmPaths.has(pathKey(r.path))).toBe(true);
      }
    });
  }
});
