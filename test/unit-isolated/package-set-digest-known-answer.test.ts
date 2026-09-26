/**
 * flair#1671 (A1c) — KNOWN-ANSWER vectors for the ONE package-set digest
 * implementation, plus the lockstep-membership refusals (F5 + F3).
 *
 * WHY THIS FILE IS A SAFETY NET. `release-pack.mjs` and the post-publish
 * canary must record the SAME package-set digest, or the canary refuses a
 * correct release. If the digest ever changes its canonical form (line format,
 * sort, separator, trailing newline) the canary breaks. So we pin the exact
 * output for three fixed inputs and assert the shared function reproduces them
 * byte-for-byte, independent of any live package tree.
 *
 * HOW THE VECTORS WERE COMPUTED. They were derived ONCE from the PRE-CHANGE
 * release code — the private digest that lived in `release-pack.mjs`
 * (commit 08dce3ba, slice A1a): `sha256(packageSetLines(packages))`, where
 * `packageSetLines` builds one `name@version sha256` line per package, `sort()`s
 * the lines (JS default, byte-identical to `LC_ALL=C sort` for these ASCII
 * names), and joins with "\n" plus a trailing "\n". The three inputs are FIXED
 * and self-contained (the names below are the nine lockstep packages; each
 * member's sha256 is a fixed literal, not the real release sha):
 *
 *    1. canonical   — all nine members at version 0.29.0.
 *    2. one-changed — the same nine members, but @tpsdev-ai/flair-mcp's sha
 *                     is a different fixed literal (every other member identical).
 *    3. reordered   — the canonical set with the members fed in a DIFFERENT
 *                     order (reversed).
 *
 * Because the digest SORTS its lines, the reordered input yields EXACTLY the
 * canonical digest: the digest is order-insensitive to its input, which is the
 * property a byte-match canary relies on. The two vectors below for canonical and
 * reordered are therefore identical on purpose.
 *
 * F3 (the guard). When `options.expected` is supplied (release-pack passes
 * `lockstepPackages(root)`), the set of pair names must be exactly that set as a
 * SET: no missing member, no extra member, no duplicate. Each refusal names the
 * offending package.
 */

import { describe, expect, test } from "bun:test";
import { computePackageSetDigest } from "../../scripts/ci/package-set-digest.mjs";
import { lockstepPackages } from "../../scripts/ci/lockstep-packages.mjs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// ── The fixed inputs ─────────────────────────────────────────────────────────
// The nine lockstep package names (the set under test), a single lockstep
// version, and a fixed sha256 per member. These literals are the known answer's
// INPUT; the expected digests below are the known answer's OUTPUT.
const VERSION = "0.29.0";

const MEMBERS = [
   "@tpsdev-ai/adk-flair",
   "@tpsdev-ai/flair-bench",
   "@tpsdev-ai/flair-client",
   "@tpsdev-ai/flair-mcp",
   "@tpsdev-ai/langgraph-flair",
   "@tpsdev-ai/n8n-nodes-flair",
   "@tpsdev-ai/openclaw-flair",
   "@tpsdev-ai/pi-flair",
   "@tpsdev-ai/flair",
] as const;

const SHA: Record<string, string> = {
   "@tpsdev-ai/adk-flair": "46fbae601989f47641b204ba9dd4432fdf9c34f3a2fb30472ff5350c533b65d9",
   "@tpsdev-ai/flair-bench": "5500aa661277b13af4c6ed7c10a6e88c8dd90c49fc4762ddbad66dba47b858b8",
   "@tpsdev-ai/flair-client": "8ae3304ec471232c2faf9dabf820e14dcaa9436e4bde1349d035b8516df3ebae",
   "@tpsdev-ai/flair-mcp": "eac51fa46dd5aecf5dc99835b6aa9c9a4f3f1ee29b892bcda9a4054f94424eb1",
   "@tpsdev-ai/langgraph-flair": "8c5c40c416d11778830b52b5868b8e69e8631806f2482cf572121d089321a2bd",
   "@tpsdev-ai/n8n-nodes-flair": "ca3a379c0997cca4d92f3b7dd81a3ba52ac45fccb5d92012ba86c374168db672",
   "@tpsdev-ai/openclaw-flair": "872571cd40c572d385f8f4b220d59403c92945d66acf0f3606e6d7ba8689b2dc",
   "@tpsdev-ai/pi-flair": "4205513e2aeafc43f6765fdafedd8c227e47b4382d4f2c575027c2288a43e402",
   "@tpsdev-ai/flair": "6ecf6de590b31cc2b00c7ff6acd2af3ec2230de0488c2c39dc902fdd90f56599",
};

// @tpsdev-ai/flair-mcp with a DIFFERENT (but still 64-hex) sha — the one member
// whose hash changed in the second input set.
const CHANGED_NAME = "@tpsdev-ai/flair-mcp";
const CHANGED_SHA = "b2953908d9b09d9da10ef13c6410ce3495b007e46d8093cac1a48508132f6041";

// The three known-answer digest vectors, computed from the pre-change release
// code (08dce3ba) over the three fixed inputs above.
const VEC_CANONICAL = "5bd1515f7bd30298fecb9c66b313d8b2974f924705d7c6f94c0fbb4f6d02c6db";
const VEC_ONE_CHANGED = "82f80a14fa125593d859ae56a33a194f2a23aa13bfb35ba656dd8eb3fa991353";
const VEC_REORDERED = "5bd1515f7bd30298fecb9c66b313d8b2974f924705d7c6f94c0fbb4f6d02c6db";

const canonicalPairs = MEMBERS.map((n) => [n, SHA[n]] as [string, string]);
const oneChangedPairs = MEMBERS.map((n) => [n, n === CHANGED_NAME ? CHANGED_SHA : SHA[n]] as [string, string]);
// Same members, fed in the opposite order.
const reorderedPairs = [...canonicalPairs].reverse();

describe("F5 · the ONE package-set digest reproduces pre-change known-answer vectors", () => {
  test("input 1 · the canonical lockstep set digests to the pinned vector", () => {
    expect(computePackageSetDigest(canonicalPairs, VERSION)).toBe(VEC_CANONICAL);
  });

  test("input 2 · changing one member's sha changes the digest (to the pinned vector)", () => {
    const digest = computePackageSetDigest(oneChangedPairs, VERSION);
    expect(digest).toBe(VEC_ONE_CHANGED);
     // A single bit change in any member's hash must not leave the digest equal.
    expect(digest).not.toBe(VEC_CANONICAL);
  });

  test("input 3 · the same set in a different order digests identically (ordered-insensitive)", () => {
    expect(computePackageSetDigest(reorderedPairs, VERSION)).toBe(VEC_REORDERED);
     // The digest sorts its lines, so input order never changes the result.
    expect(VEC_REORDERED).toBe(VEC_CANONICAL);
    expect(computePackageSetDigest(reorderedPairs, VERSION)).toBe(computePackageSetDigest(canonicalPairs, VERSION));
  });
});

describe("F3 · release-pack's call path (expected = the lockstep set) keeps the same vectors", () => {
  test("with expected = MEMBERS, the three inputs still digests to the three vectors", () => {
    expect(computePackageSetDigest(canonicalPairs, VERSION, { expected: [...MEMBERS] })).toBe(VEC_CANONICAL);
    expect(computePackageSetDigest(oneChangedPairs, VERSION, { expected: [...MEMBERS] })).toBe(VEC_ONE_CHANGED);
    expect(computePackageSetDigest(reorderedPairs, VERSION, { expected: [...MEMBERS] })).toBe(VEC_REORDERED);
  });

  test("the exact membership passes, so the guard does not swallow a correct set", () => {
    expect(() => computePackageSetDigest(reorderedPairs, VERSION, { expected: [...MEMBERS] })).not.toThrow();
  });
});

describe("F3 · the digest refuses a set that is not exactly the expected lockstep set", () => {
  // A small, fully self-contained expected set — no dependency on the live tree.
  const EXP = ["@tpsdev-ai/a", "@tpsdev-ai/b", "@tpsdev-ai/c"];
  const S1 = "a".repeat(64);
  const S2 = "b".repeat(64);
  const S3 = "c".repeat(64);
  const S4 = "d".repeat(64);

  function messageFor(pairs: [string, string][]): string {
    try {
      computePackageSetDigest(pairs, VERSION, { expected: EXP });
      throw new Error("expected a throw but the digest computed");
     } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  test("a MISSING member is refused and the missing name is named", () => {
    const msg = messageFor([["@tpsdev-ai/a", S1], ["@tpsdev-ai/b", S2]]);
    expect(msg).toContain("missing");
    expect(msg).toContain("@tpsdev-ai/c");
  });

  test("an EXTRA member is refused and the extra name is named", () => {
    const msg = messageFor([["@tpsdev-ai/a", S1], ["@tpsdev-ai/b", S2], ["@tpsdev-ai/c", S3], ["@tpsdev-ai/z", S4]]);
    expect(msg).toContain("extra");
    expect(msg).toContain("@tpsdev-ai/z");
  });

  test("a DUPLICATED member is refused and the duplicated name is named", () => {
    // @tpsdev-ai/b twice => @tpsdev-ai/c is absent; both must surface.
    const msg = messageFor([["@tpsdev-ai/a", S1], ["@tpsdev-ai/b", S2], ["@tpsdev-ai/b", S3]]);
    expect(msg).toContain("duplicated");
    expect(msg).toContain("@tpsdev-ai/b");
  });
});

// ── F3 (A1c of #1671): the CLI path (no caller-supplied expected) now defaults 'expected'
// to lockstepPackages(), so a missing/extra/duplicate member is a refusal on EVERY path, not
// just the ones that pass `expected`. RED on c0bc720e (the CLI path passed no `expected`,
// so the membership check was skipped and the partial set digested). The KAT vectors stay
// byte-identical with `expected` absent, because the real lockstep set equals the test set.
describe("F3 (A1c of #1671): the default expected (lockstep set) is always checked", () => {
      const S = "a".repeat(64);
    test("F3: a direct call with the real lockstep set minus one member throws, naming the missing package", () => {
      const all9 = lockstepPackages();
      expect(all9.length).toBe(9);
      const eight = all9.slice(0, all9.length - 1); // drop the last (flair)
      const eightPairs = eight.map((n) => [n, S] as [string, string]);
      expect(() => computePackageSetDigest(eightPairs, "0.29.0")).toThrow("missing [@tpsdev-ai/flair]");
      });

    test("F3: the CLI path with the real set minus one member refuses (exit 2) naming the missing package", () => {
      const all9 = lockstepPackages();
      const eight = all9.slice(0, all9.length - 1);
      const eightIn = eight.map((n) => `${n}=${S}`).join("\n") + "\n";
      const scriptPath = join(import.meta.dir, "..", "..", "scripts/ci/package-set-digest.mjs");
      const r = spawnSync(process.execPath, [scriptPath, "--version", "0.29.0"], { input: eightIn, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("missing [@tpsdev-ai/flair]");
      });

    test("F3: with expected absent the KAT vectors are byte-identical (lockstep default equals the real set)", () => {
      // The default 'expected' is lockstepPackages() (the real 9, flair last), which equals
      // the KAT's 9-member set in the same order; the digest is byte-identical to the F3 KAT.
      expect(computePackageSetDigest(canonicalPairs, VERSION)).toBe(VEC_CANONICAL);
      });
});
