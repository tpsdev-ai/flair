// component-load-env.test.ts — pins the `loadEnv` declaration in the shipped
// config.yaml (flair#1005).
//
// Harper does NOT read a component's `.env` implicitly. It loads env files only
// for components that ask, via the built-in `loadEnv` plugin, declared in the
// component's own config.yaml. flair shipped without that block, so a `.env`
// deployed alongside config.yaml was inert: the file arrived, and its values
// never reached `process.env`. The visible symptom was a public deployment
// whose OAuth discovery document advertised a loopback issuer even though
// `FLAIR_PUBLIC_URL` was set in the deployed component's `.env` (flair#1000).
//
// Two things are asserted here, and the second is the one that is easy to lose:
//
//   1. The block exists and points at `.env`.
//   2. It is declared BEFORE `jsResource`. Harper's component loader iterates
//      config keys in file order and awaits each plugin's initial entry load
//      before processing the next key, so declaration order decides whether
//      `process.env` is populated before `dist/resources/*.js` are imported.
//      Most read sites evaluate per request and would not notice
//      (resources/OAuth.ts, resources/AdminInstance.ts, resources/XAA.ts,
//      resources/a2a-url.ts), but resources/mcp-oauth.ts decides at MODULE LOAD
//      whether to mount `/mcp`. Measured against a real spawned Harper: with
//      `loadEnv` first, a `.env` carrying `FLAIR_MCP_OAUTH` mounts `/mcp`; with
//      the identical `.env` and `loadEnv` moved below `jsResource`, `/mcp` is
//      never mounted while the per-request issuer still resolves. Ordering is
//      behaviour, not tidiness — hence a test rather than only a comment.
//
// Deliberately NOT asserted: that a `.env` exists. Practically every install
// has none, and the plugin simply never fires when the glob matches nothing —
// a boot with the block and no `.env` is line-for-line identical to a boot
// without the block.
//
// This reads the real config.yaml rather than a fixture: a fixture would keep
// passing while the shipped file drifted, which is the exact failure mode
// (a declaration nothing consumes) that flair#1005 exists to fix.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const CONFIG_PATH = join(import.meta.dir, "..", "..", "config.yaml");
const raw = readFileSync(CONFIG_PATH, "utf8");
const config = yaml.load(raw) as Record<string, unknown>;

describe("config.yaml loadEnv declaration (flair#1005)", () => {
  test("declares the loadEnv plugin against .env", () => {
    const loadEnv = config.loadEnv as { files?: unknown } | undefined;
    expect(loadEnv).toBeDefined();
    expect(loadEnv?.files).toBe(".env");
  });

  test("declares loadEnv before jsResource so env is set before resources import", () => {
    const keys = Object.keys(config);
    expect(keys).toContain("loadEnv");
    expect(keys).toContain("jsResource");
    expect(keys.indexOf("loadEnv")).toBeLessThan(keys.indexOf("jsResource"));
  });

  test("loadEnv pattern stays inside the component directory", () => {
    // Harper's Component throws ComponentInvalidPatternError on a pattern
    // containing '..' or starting with '/', and the boot-time pre-pass warns
    // and skips it — the component fails to load rather than degrading
    // quietly. Observed: an invalid pattern produced both a
    // `Ignoring invalid loadEnv files pattern` warning and a
    // `Could not load component 'loadEnv'` error at boot.
    const files = (config.loadEnv as { files?: unknown } | undefined)?.files;
    // Assert the value is there FIRST: with no declaration at all, `""` would
    // satisfy both checks below and this test would report a pass for a
    // configuration it never examined.
    expect(typeof files).toBe("string");
    expect(String(files).includes("..")).toBe(false);
    expect(String(files).startsWith("/")).toBe(false);
  });

  test("does not try to shape Harper's own configuration from a component .env", () => {
    // Harper composes its instance configuration BEFORE component .env files
    // load, and refuses these three at the injection point (harper#1513).
    // Nothing in the shipped config may imply otherwise.
    for (const key of ["HARPER_CONFIG", "HARPER_DEFAULT_CONFIG", "HARPER_SET_CONFIG"]) {
      expect(raw.includes(`${key}=`)).toBe(false);
    }
  });
});
