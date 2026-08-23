import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mcpServerSpec,
  unpinnedSpecWarning,
  resolveFlairCliVersion,
  flairCliVersion,
  isResolvedVersion,
  UNKNOWN_VERSION,
  FLAIR_MCP_PACKAGE,
} from "../../src/lib/mcp-spec.ts";
import { ALL_CLIENTS, clientConfigPath, type ClientId } from "../../src/install/clients.ts";

/**
 * flair#907 — `flair init` wrote an UNPINNED `@tpsdev-ai/flair-mcp` into every
 * client config, while docs/mcp-clients.md promised a pin.
 *
 * The mechanism was NOT that the CLI failed to read its own version (a stock
 * global install resolves it fine, and `--version` was always correct). It was
 * that `mcpServerSpec()` lived in src/cli.ts and was applied at exactly ONE of
 * the five places that write a spec: src/install/clients.ts hardcoded the bare
 * package string in `flairMcpEntry()` (Claude Code fallback / Gemini / Cursor)
 * and in `tomlSnippet()` (Codex).
 *
 * So the tests that matter here are about the WRITERS, not the helper — and
 * they read the expected version straight from package.json rather than from
 * mcpServerSpec(), so a regression that unpins both the writer and the helper
 * still fails (a test that asks a delegate to confirm its own output cannot
 * catch a delegate that stopped doing the work).
 */

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
).version;

const ENV = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

describe("every client writer pins the MCP spec (flair#907)", () => {
  // Iterating the registry rather than naming clients is deliberate: a client
  // added later is covered without anyone remembering to extend this test,
  // which is the exact failure mode that produced the bug. Filtered on kind:
  // pi (native-extension, flair#1342) never writes an MCP spec at all — its
  // own pin discipline (npm:@tpsdev-ai/pi-flair@<version> in pi's `packages`)
  // is asserted in test/unit/pi-client.test.ts.
  for (const client of ALL_CLIENTS.filter((c) => c.kind === "mcp")) {
    it(`${client.label}: writes a pinned spec into its real config file`, () => {
      const res = client.wire({ ...ENV, FLAIR_CLIENT: client.id });
      expect(res.ok).toBe(true);

      const raw = readFileSync(clientConfigPath(client.id as ClientId), "utf-8");

      // Present in the pinned form...
      expect(raw).toContain(`${FLAIR_MCP_PACKAGE}@${PKG_VERSION}`);
      // ...and absent in the unpinned one. Both formats (JSON args array and
      // Codex TOML) close the package name with a double quote, so a bare
      // `"@tpsdev-ai/flair-mcp"` is exactly what an unpinned write looks like.
      expect(raw).not.toContain(`"${FLAIR_MCP_PACKAGE}"`);
    });
  }
});

describe("mcpServerSpec", () => {
  it("pins to the given version", () => {
    expect(mcpServerSpec("0.28.0")).toBe("@tpsdev-ai/flair-mcp@0.28.0");
  });

  it("resolves a real version by default on this checkout", () => {
    expect(flairCliVersion()).toBe(PKG_VERSION);
    expect(mcpServerSpec()).toBe(`${FLAIR_MCP_PACKAGE}@${PKG_VERSION}`);
  });
});

describe("an unresolvable version is never a SILENT downgrade (flair#907)", () => {
  /**
   * The invariant, stated as a check rather than as a comment a reviewer has
   * to remember: any version for which we emit the unpinned spec MUST also
   * produce a warning. Falling back is a decision; falling back quietly is the
   * defect — a user who read the docs believes they are pinned, and an
   * unpinned spec re-resolves to whatever is published on every future
   * session.
   */
  const unresolvable = ["unknown", "", UNKNOWN_VERSION];

  for (const version of unresolvable) {
    it(`version ${JSON.stringify(version)}: unpinned spec comes WITH a warning`, () => {
      expect(isResolvedVersion(version)).toBe(false);
      expect(mcpServerSpec(version)).toBe(FLAIR_MCP_PACKAGE);
      const warning = unpinnedSpecWarning(version);
      expect(warning).not.toBeNull();
      expect(typeof warning).toBe("string");
    });
  }

  it("binds the two: whenever the spec is unpinned, a warning exists", () => {
    for (const version of [...unresolvable, "0.30.0", PKG_VERSION, "1.2.3"]) {
      const spec = mcpServerSpec(version);
      const isUnpinned = spec === FLAIR_MCP_PACKAGE;
      const warned = unpinnedSpecWarning(version) !== null;
      expect(warned).toBe(isUnpinned);
    }
  });

  it("the warning names the consequence and a remedy, not just the fact", () => {
    // "technically accurate" is what passes review and fails at 3am. The
    // warning has to tell the reader what is now true of their machine and
    // what to do about it.
    const warning = unpinnedSpecWarning(UNKNOWN_VERSION)!;
    expect(warning).toContain("UNPINNED");
    expect(warning.toLowerCase()).toContain("consequence");
    expect(warning).toContain("latest published version");
    expect(warning).toContain("Fix:");
  });

  it("a resolved version produces no warning", () => {
    expect(unpinnedSpecWarning("0.30.0")).toBeNull();
    expect(unpinnedSpecWarning(PKG_VERSION)).toBeNull();
  });
});

describe("resolveFlairCliVersion", () => {
  it("finds this repo's version by walking up from a nested directory", () => {
    // dist/lib/ is two levels below the package root in a real install; the
    // resolver must not depend on that depth.
    expect(resolveFlairCliVersion(join(import.meta.dirname, "..", "..", "src", "lib"))).toBe(PKG_VERSION);
    expect(resolveFlairCliVersion(join(import.meta.dirname, "..", ".."))).toBe(PKG_VERSION);
  });

  it("returns 'unknown' when no @tpsdev-ai/flair package.json is above it", () => {
    const orphan = mkdtempSync(join(tmpdir(), "flair-orphan-"));
    try {
      expect(resolveFlairCliVersion(orphan)).toBe(UNKNOWN_VERSION);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("ignores a package.json belonging to some other package", () => {
    // A stray package.json in an intermediate directory must not be mistaken
    // for ours and yield a wrong pin.
    const root = mkdtempSync(join(tmpdir(), "flair-stray-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-flair", version: "9.9.9" }));
      const nested = join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      expect(resolveFlairCliVersion(nested)).toBe(UNKNOWN_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
