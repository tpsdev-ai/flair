import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Public plugin mcp.json files are what directory listings scrape.
 * A version or dist-tag pin (`@tpsdev-ai/flair-mcp@0.44.13`) rots the
 * listing while npm latest moves on. Unpinning is the policy (flair#1307).
 *
 * The CI gate is scripts/check-plugin-mcp-unpinned.mjs. These tests pin
 * the cursor-flair env contract and prove the pin detector would have
 * caught the 0.44.13 drift.
 */
const PACKAGES = join(import.meta.dir, "../../packages");
const PIN = "@tpsdev-ai/flair-mcp@";

function pluginMcpJsonPaths(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(PACKAGES)) {
    for (const file of ["mcp.json", ".mcp.json"]) {
      try {
        const p = join(PACKAGES, name, file);
        readFileSync(p);
        out.push(p);
      } catch {
        // package has no plugin mcp.json
      }
    }
  }
  return out;
}

describe("public plugin mcp.json", () => {
  const paths = pluginMcpJsonPaths();

  test("at least one public plugin mcp.json exists", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  test("does not pin @tpsdev-ai/flair-mcp to a version or dist-tag", () => {
    for (const p of paths) {
      const text = readFileSync(p, "utf8");
      expect(text.includes(PIN), `${p} contains ${PIN}`).toBe(false);
    }
  });

  test("cursor-flair keeps the existing env contract and unpinned npx spec", () => {
    const cfg = JSON.parse(readFileSync(join(PACKAGES, "cursor-flair", "mcp.json"), "utf8"));
    const flair = cfg.mcpServers.flair;
    expect(flair.command).toBe("npx");
    expect(flair.args).toEqual(["-y", "@tpsdev-ai/flair-mcp"]);
    expect(flair.env).toEqual({
      FLAIR_AGENT_ID: "${FLAIR_AGENT_ID}",
      FLAIR_URL: "${FLAIR_URL}",
      FLAIR_CLIENT: "cursor",
    });
  });

  test("the pin detector would have caught @tpsdev-ai/flair-mcp@0.44.13", () => {
    // Same predicate the CI script uses (indexOf of the `@` pin suffix).
    expect('["-y", "@tpsdev-ai/flair-mcp@0.44.13"]'.includes(PIN)).toBe(true);
    expect('["-y", "@tpsdev-ai/flair-mcp@latest"]'.includes(PIN)).toBe(true);
    expect('["-y", "@tpsdev-ai/flair-mcp"]'.includes(PIN)).toBe(false);
  });
});
