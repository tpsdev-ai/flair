/**
 * vendored-tool-descriptors.test.ts — flair#1683.
 *
 * `@tpsdev-ai/flair-tool-descriptors` is a private, build-time source: it is
 * never published, so declaring it in `dependencies` 404s a fresh global
 * install, and `bundleDependencies` broke npm's reify against harper's own
 * npm-shrinkwrap.json (the 0.54.1 incident — see
 * scripts/check-global-install-lockfile.mjs and #1681).
 *
 * So it must be neither. Instead its source is copied into each consumer at
 * build time and imported by RELATIVE path — the only specifier that resolves
 * inside a packed tarball. This file pins that shape: the dependency and the
 * bundle field stay gone, every consumer imports the vendored copy, the copies
 * are generated (gitignored) and byte-equal to the source, and the private
 * package stays out of the publish set.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESCRIPTORS_PKG_REL,
  DESCRIPTORS_SRC_REL,
  VENDORED_FILE,
  VENDOR_TARGETS,
  vendorToolDescriptors,
  vendoredContent,
} from "../../scripts/vendor-tool-descriptors.mjs";
import {
  enumeratePublishTargets,
  parseReleasePublishDirs,
} from "../../scripts/first-publish-check.mjs";

const REPO = join(import.meta.dir, "../..");
const BUNDLED_NAME = "@tpsdev-ai/flair-tool-descriptors";
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Consumers that must reach the descriptors by relative path, not by package name. */
const CONSUMER_FILES = [
  "resources/mcp-tools.ts",
  "packages/flair-mcp/src/adapter-surface.ts",
  "packages/flair-mcp/src/adapter-tools.ts",
  "packages/flair-mcp/src/json-schema-zod.ts",
  "packages/flair-mcp/test/adapter-surface.test.ts",
  "packages/flair-mcp/test/catchup.test.ts",
];

describe("vendored tool descriptors (flair#1683)", () => {
  test("neither consumer declares, dev-depends on, or bundles the private package", () => {
    for (const rel of ["package.json", "packages/flair-mcp/package.json"]) {
      const pkg = JSON.parse(readFileSync(join(REPO, rel), "utf8"));
      expect(pkg.dependencies?.[BUNDLED_NAME], `${rel} dependencies`).toBeUndefined();
      expect(pkg.devDependencies?.[BUNDLED_NAME], `${rel} devDependencies`).toBeUndefined();
      expect(pkg.bundleDependencies ?? [], `${rel} bundleDependencies`).toEqual([]);
      // The retired materializer ran here; nothing should prepack the descriptors
      // PACKAGE. `prepack` itself must exist — it re-vendors + rebuilds so a bare
      // `npm pack` cannot ship a stale/tampered dist (Sherlock's BLOCKING 2).
      expect(pkg.scripts?.prepack, `${rel} prepack`).toBeDefined();
      expect(pkg.scripts?.prepack, `${rel} prepack must not touch the private package`).not.toContain(
        "flair-tool-descriptors",
      );
    }
  });

  test("a bare `npm pack` re-vendors and rebuilds via prepack", () => {
    // prepack (not prepublishOnly) because `npm pack` — what the Docker pack
    // images, pack-smoke and install-weight run — fires prepack but NOT
    // prepublishOnly. Without it, a stale dist/ ships verbatim: Sherlock injected
    // a marker into dist/resources/tool-descriptors/index.js and packed it.
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(REPO, "packages/flair-mcp/package.json"), "utf8"));
    // Rebuilding runs prebuild first, which is where the vendoring happens.
    expect(root.scripts.prepack).toBe("npm run build && npm run build:cli");
    expect(root.scripts.prebuild).toContain("scripts/vendor-tool-descriptors.mjs");
    expect(mcp.scripts.prepack).toBe("npm run build");
    expect(mcp.scripts.prebuild).toContain("scripts/vendor-tool-descriptors.mjs");
    // And the shipped artifact is bound to the source of truth by the
    // install-weight lane (scripts/check-shipped-descriptors.mjs).
  });

  test("both consumers vendor at prebuild time", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(REPO, "packages/flair-mcp/package.json"), "utf8"));
    expect(root.scripts.prebuild).toContain("scripts/vendor-tool-descriptors.mjs");
    expect(mcp.scripts.prebuild).toContain("scripts/vendor-tool-descriptors.mjs");
    expect(root.scripts.prebuild).not.toContain("packages/flair-tool-descriptors");
  });

  test("consumers import the vendored copy by relative path, never the bare package", () => {
    for (const rel of CONSUMER_FILES) {
      const src = readFileSync(join(REPO, rel), "utf8");
      expect(src, `${rel} must not import the bare descriptor package`).not.toContain(`"${BUNDLED_NAME}"`);
      expect(src, `${rel} must import the vendored copy`).toContain("tool-descriptors/index.js");
    }
  });

  test("vendored copies are gitignored — generated, never committed", () => {
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    for (const target of VENDOR_TARGETS) expect(ignore, `${target} must be gitignored`).toContain(`${target}/`);
  });

  test("vendored content is exactly the source, behind a generated banner", () => {
    const content = vendoredContent(REPO);
    const src = readFileSync(join(REPO, DESCRIPTORS_SRC_REL), "utf8");
    expect(content.endsWith(src)).toBe(true);
    expect(content.length).toBeGreaterThan(src.length);
    expect(content).toMatch(/GENERATED FILE/);
  });

  test("the API vendors into an arbitrary root (no git, no workspace)", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-vendor-"));
    fixtures.push(root);
    mkdirSync(join(root, DESCRIPTORS_PKG_REL, "src"), { recursive: true });
    cpSync(join(REPO, DESCRIPTORS_SRC_REL), join(root, DESCRIPTORS_SRC_REL));
    const src = readFileSync(join(root, DESCRIPTORS_SRC_REL), "utf8");
    for (const target of VENDOR_TARGETS) {
      const written = vendorToolDescriptors(target, root);
      expect(written).toBe(join(root, target, VENDORED_FILE));
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf8").endsWith(src)).toBe(true);
    }
  });

  test("the on-disk copies match the source (test:unit vendors before this runs)", () => {
    const src = readFileSync(join(REPO, DESCRIPTORS_SRC_REL), "utf8");
    for (const target of VENDOR_TARGETS) {
      const file = join(REPO, target, VENDORED_FILE);
      const where = `${target}/${VENDORED_FILE}`;
      expect(
        existsSync(file),
        `${where} is missing — run \`node scripts/vendor-tool-descriptors.mjs\` (test:unit does this)`,
      ).toBe(true);
      expect(readFileSync(file, "utf8").endsWith(src), `${where} diverged from ${DESCRIPTORS_SRC_REL}`).toBe(true);
    }
  });

  test("the descriptor package stays private and out of the publish set", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, DESCRIPTORS_PKG_REL, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);

    const workflow = readFileSync(join(REPO, ".github/workflows/release-publish.yml"), "utf8");
    expect(parseReleasePublishDirs(workflow)).not.toContain(DESCRIPTORS_PKG_REL);
    expect(workflow).not.toMatch(/npm\s+stage\s+publish[\s\S]{0,120}flair-tool-descriptors/);

    const { targets, problems } = enumeratePublishTargets(REPO);
    expect(problems).toEqual([]);
    expect(targets.map((t) => t.name)).not.toContain(BUNDLED_NAME);
  });

  test("every Dockerfile that packs in-image copies the vendor script, not the retired materializer", () => {
    const dockerDir = join(REPO, "docker");
    const packers = readdirSync(dockerDir)
      .filter((name) => name.startsWith("Dockerfile"))
      .filter((name) => readFileSync(join(dockerDir, name), "utf8").includes("npm pack"));
    expect(packers.length, "expected at least the two pack-in-image Dockerfiles").toBeGreaterThanOrEqual(2);
    for (const name of packers) {
      const text = readFileSync(join(dockerDir, name), "utf8");
      expect(
        text,
        `${name} must COPY scripts/vendor-tool-descriptors.mjs — prebuild MODULE_NOT_FOUND otherwise`,
      ).toContain("scripts/vendor-tool-descriptors.mjs");
      expect(text, `${name} still references the retired materializer`).not.toContain(
        "materialize-bundled-descriptors",
      );
    }
  });
});
