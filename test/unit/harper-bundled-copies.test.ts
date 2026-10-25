/**
 * The harper 5.3.2+ bundle sits under node_modules/harper/node_modules, where a
 * root override does not reach it and bun audit cannot see it. These tests pin
 * the listing a reviewer reads, and that an unmeasurable tree exits 2 — never 0.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listBundledCopies, main } from "../../scripts/ci/list-harper-bundled.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "harper-bundled-"));
  roots.push(root);
  for (const [rel, manifest] of Object.entries(files)) {
    const file = join(root, "node_modules", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
  return root;
}

const harper = (extra: Record<string, unknown> = {}) => ({ name: "harper", version: "5.3.4", ...extra });

describe("harper's bundled copies", () => {
  test("lists top-level, scoped and nested copies with their versions", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify", "@fastify/static", "fast-uri"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
      "harper/node_modules/fastify/node_modules/fast-uri/package.json": { name: "fast-uri", version: "4.2.1" },
      "harper/node_modules/@fastify/static/package.json": { name: "@fastify/static", version: "9.3.0" },
      "harper/node_modules/fast-uri/package.json": { name: "fast-uri", version: "3.1.0" },
    });
    const listing = listBundledCopies(join(root, "node_modules"));
    expect(listing.harperVersion).toBe("5.3.4");
    expect(listing.declared).toEqual(["fastify", "@fastify/static", "fast-uri"]);
    expect(listing.copies.map((copy) => `${copy.name}@${copy.version}`)).toEqual([
      "@fastify/static@9.3.0",
      "fast-uri@3.1.0",
      "fastify@5.12.5",
      "fast-uri@4.2.1",
    ]);
  });

  test("a harper without bundleDependencies exits 2 and says so", () => {
    const root = fixture({
      "harper/package.json": harper(),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("declares no bundleDependencies");
  });

  test("a missing harper tree exits 2", () => {
    const root = fixture({ "unrelated/package.json": { name: "unrelated", version: "1.0.0" } });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/harper/);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("harper bundled copies:");
  });

  test("an installed copy without a readable manifest exits 2", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify" },
    });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/no non-empty string name and version/);
  });

  test("a declared bundle entry with no directory exits 2, naming it", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify", "missing-pkg"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/missing-pkg.*has no directory/);
  });

  test("a package directory with no manifest exits 2, naming the path", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    mkdirSync(join(root, "node_modules", "harper", "node_modules", "stray"), { recursive: true });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/stray.*has no package\.json/);
  });

  test("an unreadable manifest exits 2 for root too, naming the path", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    // A directory where the manifest belongs: readFileSync fails with EISDIR,
    // which root does not bypass (chmod 000 would).
    const manifestPath = join(root, "node_modules", "harper", "node_modules", "fastify", "package.json");
    rmSync(manifestPath);
    mkdirSync(manifestPath, { recursive: true });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/cannot read .*fastify.*package\.json/);
  });

  test("a manifest-less copy makes main exit 2 instead of skipping it", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    mkdirSync(join(root, "node_modules", "harper", "node_modules", "stray"), { recursive: true });
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("stray");
  });

  // Each case below is a bundle declaration or an installed copy the lister
  // cannot measure: it must exit 2 and name the defect, never filter it out and
  // report the rest.
  const exitsTwoNaming = (root: string, pattern: RegExp) => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toMatch(pattern);
  };

  for (const [label, entry] of [
    ["null", null],
    ["an empty string", ""],
    ["a blank string", "  "],
    ["a number", 7],
    ["an object", { name: "fastify" }],
    ["a path into another package's tree", "fastify/node_modules/fast-uri"],
    ["a scoped path with an extra segment", "@scope/pkg/extra"],
    ["a relative path", "../fastify"],
    ["a name npm refuses (a colon)", "bad:name"],
    ["a name npm refuses (uppercase)", "Fastify"],
  ] as const) {
    test(`a bundleDependencies entry that is ${label} exits 2, naming it`, () => {
      const files: Record<string, unknown> = {
        "harper/package.json": harper({ bundleDependencies: ["fastify", entry] }),
        "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
      };
      // Give a string entry its own directory where one can exist inside the bundle, so the
      // refusal cannot come from a later "no directory" check.
      if (typeof entry === "string" && entry.trim() !== "" && !entry.startsWith("..")) {
        files[`harper/node_modules/${entry}/package.json`] = { name: entry, version: "1.0.0" };
      }
      const root = fixture(files);
      exitsTwoNaming(root, /entries that are not package names: \[1\]/);
    });
  }

  test("a bundle entry that is a path to a nested copy that exists exits 2 (not accepted as declared)", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify", "fastify/node_modules/fast-uri"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
      "harper/node_modules/fastify/node_modules/fast-uri/package.json": { name: "fast-uri", version: "4.2.1" },
    });
    exitsTwoNaming(root, /entries that are not package names: \[1\] "fastify\/node_modules\/fast-uri"/);
  });

  test("a scoped bundle entry is a package name", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["@scope/pkg"] }),
      "harper/node_modules/@scope/pkg/package.json": { name: "@scope/pkg", version: "1.0.0" },
    });
    expect(listBundledCopies(join(root, "node_modules")).declared).toEqual(["@scope/pkg"]);
  });

  test("an empty bundleDependencies array exits 2 even with a package directory present", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: [] }),
      "harper/node_modules/unrelated/package.json": { name: "unrelated", version: "1.0.0" },
    });
    exitsTwoNaming(root, /declares an empty bundle/);
  });

  // `true` bundles every dependency and, under npm's bundling rules, the
  // optional ones too; the lister reads only an explicit list (harper's form).
  for (const [label, extra] of [
    ["regular dependencies", { dependencies: { fastify: "^5.8.2" } }],
    ["optional dependencies", { dependencies: { fastify: "^5.8.2" }, optionalDependencies: { "fsevents": "^2.3.3" } }],
    ["no dependencies", {}],
  ] as const) {
    test(`bundleDependencies true with ${label} exits 2 (only an explicit list is read)`, () => {
      const root = fixture({
        "harper/package.json": harper({ bundleDependencies: true, ...extra }),
        "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
        "harper/node_modules/fsevents/package.json": { name: "fsevents", version: "2.3.3" },
      });
      exitsTwoNaming(root, /declares bundleDependencies: true; this lister reads only an explicit list/);
    });
  }

  test("a harper manifest that is not JSON exits 2, naming the file", () => {
    const root = fixture({ "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" } });
    writeFileSync(join(root, "node_modules", "harper", "package.json"), "{ not json");
    exitsTwoNaming(root, /cannot parse .*harper[\\/]package\.json/);
  });

  for (const [label, manifest] of [
    ["an empty name", { name: "", version: "5.12.5" }],
    ["an empty version", { name: "fastify", version: "" }],
    ["a blank version", { name: "fastify", version: " " }],
  ] as const) {
    test(`an installed copy with ${label} exits 2, naming its manifest`, () => {
      const root = fixture({
        "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
        "harper/node_modules/fastify/package.json": manifest,
      });
      exitsTwoNaming(root, /fastify[\\/]package\.json has no non-empty string name and version/);
    });
  }
});
