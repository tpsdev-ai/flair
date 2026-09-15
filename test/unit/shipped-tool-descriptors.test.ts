/**
 * shipped-tool-descriptors.test.ts — flair#1683, the shipped half.
 *
 * scripts/check-shipped-descriptors.mjs is the gate that reads a packed tarball
 * and requires the descriptor module that ACTUALLY SHIPS to match a fresh
 * evaluation of packages/flair-tool-descriptors/src/index.ts. Its unit half
 * (`test/unit/vendored-tool-descriptors.test.ts`) pins vendored source ≡ source;
 * this file pins the artifact binding, including the two ways it must FAIL: a
 * tampered/stale module, and a tarball with zero tool-descriptors entries.
 *
 * Runs the real script as a child (with the current bun as BOTH the runner and
 * the module runtime) against fixtures, so the exit code under test is the exit
 * code CI reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DESCRIPTORS_SRC_REL,
  descriptorSignature,
  diffSignatures,
  findShippedModules,
  repoRoot,
  signatureOfModule,
} from "../../scripts/check-shipped-descriptors.mjs";

const REPO = repoRoot();
const SCRIPT = join(REPO, "scripts", "check-shipped-descriptors.mjs");
/** bun itself: the runner and the TS-capable module runtime. */
const BUN = process.execPath;

const temps: string[] = [];
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A shipped-shaped descriptor module: a verbatim re-export of the source of
 * truth, so its signature must equal the source's (this is what a correct
 * tarball carries). `mutate` turns it into the stale/tampered shape — the same
 * thing a `--ignore-scripts` pack of an edited dist/ would ship. Generated at
 * test time so the fixture cannot drift from the source it mirrors.
 */
function writeShippedModule(dir: string, descriptorsExpr = "descriptors.TOOL_DESCRIPTORS") {
  const source = new URL(`file://${join(REPO, DESCRIPTORS_SRC_REL)}`).href;
  const body = [
    `import * as descriptors from ${JSON.stringify(source)};`,
    `export const TOOL_DESCRIPTORS = ${descriptorsExpr};`,
    "export const NATIVE_TOOL_DESCRIPTORS = descriptors.NATIVE_TOOL_DESCRIPTORS;",
    "export const STDIO_TOOL_DESCRIPTORS = descriptors.STDIO_TOOL_DESCRIPTORS;",
  ].join("\n");
  const file = join(dir, "index.mjs");
  writeFileSync(file, body);
  return file;
}

/** Run the shipped-descriptors check and return its exit code + stderr. */
function runCheck(args: string[]) {
  const run = spawnSync(BUN, [SCRIPT, ...args], { encoding: "utf8", cwd: REPO });
  return { code: run.status, stderr: run.stderr ?? "", stdout: run.stdout ?? "" };
}

describe("descriptorSignature", () => {
  test("counts, sorts names, splits the surface, and digests the descriptors", () => {
    const mod = {
      TOOL_DESCRIPTORS: [
        { name: "b", description: "second", inputSchema: { type: "object" } },
        { name: "a", description: "first", inputSchema: { type: "object" } },
      ],
      NATIVE_TOOL_DESCRIPTORS: [{ name: "b" }],
      STDIO_TOOL_DESCRIPTORS: [{ name: "a" }],
    };
    const sig = descriptorSignature(mod);
    expect(sig.count).toBe(2);
    expect(sig.names).toEqual(["a", "b"]);
    expect(sig.native).toEqual(["b"]);
    expect(sig.stdio).toEqual(["a"]);
    expect(sig.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the digest moves when only an inputSchema changes (not just names)", () => {
    const base = { TOOL_DESCRIPTORS: [{ name: "a", description: "d", inputSchema: { type: "object" } }] };
    const tweaked = { TOOL_DESCRIPTORS: [{ name: "a", description: "d", inputSchema: { type: "string" } }] };
    const a = descriptorSignature(base);
    const b = descriptorSignature(tweaked);
    expect(b.names).toEqual(a.names);
    expect(b.digest).not.toBe(a.digest);
    const delta = diffSignatures(a, b);
    expect(delta.missing).toEqual([]);
    expect(delta.extra).toEqual([]);
    expect(delta.digestMatches).toBe(false);
  });

  test("an empty or shapeless module is 0 tools, not a crash", () => {
    expect(descriptorSignature({}).count).toBe(0);
    expect(descriptorSignature(undefined).count).toBe(0);
  });
});

describe("signatureOfModule", () => {
  test("evaluates the TS source of truth through bun", () => {
    const href = new URL(`file://${join(REPO, DESCRIPTORS_SRC_REL)}`).href;
    const result = signatureOfModule(href, BUN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signature.count).toBeGreaterThan(0);
      expect(result.signature.native.length + result.signature.stdio.length).toBeGreaterThanOrEqual(
        result.signature.count,
      );
    }
  });

  test("a missing runtime is a failure, not an empty signature", () => {
    const result = signatureOfModule("file:///nonexistent.js", join(REPO, "no-such-bun"));
    expect(result.ok).toBe(false);
  });
});

describe("findShippedModules", () => {
  test("finds descriptor modules under dist/, ignores the same name outside dist/", () => {
    const root = tempDir("flair-shipped-find-");
    const inside = join(root, "package", "dist", "resources", "tool-descriptors");
    const decoy = join(root, "package", "src", "tool-descriptors");
    mkdirSync(inside, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(inside, "index.js"), "export const TOOL_DESCRIPTORS = [];\n");
    writeFileSync(join(decoy, "index.js"), "export const TOOL_DESCRIPTORS = [];\n");
    expect(findShippedModules(join(root, "package"))).toEqual([join(inside, "index.js")]);
  });

  test("a missing tree is an empty list (caller decides that is a failure)", () => {
    expect(findShippedModules(join(tempDir("flair-shipped-none-"), "package"))).toEqual([]);
  });
});

describe("scripts/check-shipped-descriptors.mjs — end to end", () => {
  test("a shipped module equal to the source of truth passes", () => {
    const dir = tempDir("flair-shipped-good-");
    const { code, stderr } = runCheck(["--module", writeShippedModule(dir)]);
    expect(stderr).toContain("match the source of truth");
    expect(code).toBe(0);
  });

  test("a tampered shipped module fails, naming what diverged", () => {
    const dir = tempDir("flair-shipped-tamper-");
    // Same shape, one renamed tool — the drift a stale dist/ would carry.
    const tampered = writeShippedModule(
      dir,
      'descriptors.TOOL_DESCRIPTORS.map((d) => (d.name === "memory_store" ? { ...d, name: "memory_store_v2" } : d))',
    );
    const { code, stderr } = runCheck(["--module", tampered]);
    expect(code).toBe(1);
    expect(stderr).toContain("diverges from the source of truth");
    expect(stderr).toContain("missing memory_store");
    expect(stderr).toContain("unexpected memory_store_v2");
  });

  test("a tarball with zero tool-descriptors entries FAILS (never a silent pass)", () => {
    const dir = tempDir("flair-shipped-empty-");
    mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(
      join(dir, "package", "package.json"),
      JSON.stringify({ name: "@tpsdev-ai/flair", version: "0.54.1", type: "module" }),
    );
    const tarball = join(dir, "empty.tgz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "package"], { encoding: "utf8" });
    expect(tar.status).toBe(0);
    const { code, stderr } = runCheck(["--tarball", tarball]);
    expect(code).toBe(1);
    expect(stderr).toContain("ships no tool descriptors at all");
  });

  test("no input is DID NOT RUN (2), never 0", () => {
    const { code, stderr } = runCheck([]);
    expect(code).toBe(2);
    expect(stderr).toContain("DID NOT RUN");
  });

  test("a missing tarball or module is DID NOT RUN (2), never 0", () => {
    expect(runCheck(["--module", join(tempDir("flair-shipped-nomod-"), "nope.js")]).code).toBe(2);
    expect(runCheck(["--tarball", join(tempDir("flair-shipped-notgz-"), "nope.tgz")]).code).toBe(2);
  });
});

describe("the install-weight lane runs this check against the packed tarballs", () => {
  const yml = readFileSync(join(REPO, ".github", "workflows", "test.yml"), "utf8");
  // The lane body only — job header up to the install-weight step — so an
  // assertion here cannot be satisfied by a step in some other job.
  const lane = yml.slice(yml.indexOf("name: Install-weight budget"), yml.indexOf("check-install-weight.mjs"));
  // Comments in this lane intentionally name `--ignore-scripts` (to say the
  // packs do NOT use it); strip them so the assertions read the commands.
  const commands = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  test("the lane builds both descriptor consumers before checking their dist", () => {
    const mcpBuild = lane.indexOf("working-directory: packages/flair-mcp");
    const moduleCheck = lane.indexOf("scripts/check-shipped-descriptors.mjs");
    // flair-mcp is not built by the root scripts. Without this build its dist
    // module does not exist and the check exits 2 (DID NOT RUN) — red, but for a
    // reason that hides the artifact it was meant to bind.
    expect(mcpBuild).toBeGreaterThan(-1);
    expect(mcpBuild).toBeLessThan(moduleCheck);
  });

  test("the lane checks both BUILT dist modules against the source, before packing", () => {
    const beforePack = commands(lane.slice(lane.indexOf("scripts/check-shipped-descriptors.mjs"), lane.indexOf("- name: Pack")));
    expect(beforePack).toContain("--module dist/resources/tool-descriptors/index.js");
    expect(beforePack).toContain("--module packages/flair-mcp/dist/tool-descriptors/index.js");
  });

  test("both packs are bare `npm pack` (so prepack re-vendors + rebuilds)", () => {
    const packs = commands(lane.slice(lane.indexOf("- name: Pack"), lane.indexOf("check-install-weight.mjs")));
    expect(packs).not.toContain("--ignore-scripts");
    expect((packs.match(/npm pack/g) ?? []).length).toBe(2);
    expect(packs).toContain("tpsdev-ai-flair-mcp-*.tgz");
  });

  test("the check reads both published tarballs, after they are packed", () => {
    const afterPacks = commands(lane.slice(lane.indexOf("scripts/check-shipped-descriptors.mjs", lane.indexOf("- name: Pack"))));
    expect((afterPacks.match(/--tarball/g) ?? []).length).toBe(2);
    expect(afterPacks).toContain("steps.pack.outputs.TGZ_PATH");
    expect(afterPacks).toContain("steps.pack-mcp.outputs.TGZ_PATH");
  });
});
