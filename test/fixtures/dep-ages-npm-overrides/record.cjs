#!/usr/bin/env node
/**
 * Records how npm itself reads each `overrides` case in npm-overrides.json, so
 * test/unit/check-dep-ages-npm-conformance.test.ts can check the bake-time
 * gate's override classification against npm's grammar without network access
 * or an npm dependency in this repo.
 *
 * Usage: node record.cjs <npm's own node_modules directory>
 *   (the directory that holds @npmcli/arborist and npm-package-arg, e.g.
 *   "$(npm root -g)/npm/node_modules")
 *
 * For every case it builds npm's OverrideSet from the case's `overrides`
 * value, walks every rule it derives, and parses each rule's value the way an
 * overridden edge is parsed (npm-package-arg's resolve(name, value)). It
 * rewrites the `npm` member of each case and the `recordedWith` versions.
 */
"use strict";
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const npmModules = process.argv[2];
if (!npmModules) {
  console.error("usage: node record.cjs <npm's own node_modules directory>");
  process.exit(2);
}
const OverrideSet = require(join(npmModules, "@npmcli/arborist/lib/override-set.js"));
const npa = require(join(npmModules, "npm-package-arg"));
const semver = require(join(npmModules, "semver"));
const version = (pkg) => JSON.parse(readFileSync(join(npmModules, pkg, "package.json"), "utf8")).version;

function parseValue(name, value) {
  if (typeof value !== "string") return { type: "not-a-string" };
  if (value === "*") return { type: "no-override" };
  if (value.startsWith("$")) return { type: "reference" };
  try {
    const spec = npa.resolve(name, value);
    const out = { type: spec.type };
    if (spec.type === "version") out.version = semver.valid(spec.fetchSpec, true);
    if (spec.type === "alias") {
      out.target = spec.subSpec.name;
      out.targetType = spec.subSpec.type;
      if (spec.subSpec.type === "version") out.version = semver.valid(spec.subSpec.fetchSpec, true);
    }
    return out;
  } catch (err) {
    return { type: "error", error: String(err.message) };
  }
}

function record(overrides) {
  let root;
  try {
    root = new OverrideSet({ overrides: structuredClone(overrides) });
  } catch (err) {
    return { error: String(err.message) };
  }
  const rules = [];
  const walk = (set, path) => {
    for (const child of set.children.values()) {
      const childPath = [...path, child.key];
      rules.push({
        path: childPath,
        name: child.name,
        keySpec: child.keySpec,
        value: typeof child.value === "string" ? child.value : null,
        parsed: parseValue(child.name, child.value),
      });
      walk(child, childPath);
    }
  };
  walk(root, []);
  return { rules };
}

const fixturePath = join(__dirname, "npm-overrides.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
fixture.recordedWith = {
  npm: version(".."),
  "@npmcli/arborist": version("@npmcli/arborist"),
  "npm-package-arg": version("npm-package-arg"),
  semver: version("semver"),
};
for (const c of fixture.cases) c.npm = record(c.overrides);
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`recorded ${fixture.cases.length} cases with npm ${fixture.recordedWith.npm}`);
