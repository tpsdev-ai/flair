// flair#1209 — add the Antigravity CLI (`agy`) as a wire-able MCP client.
//
// Antigravity (the agy CLI + the 2.0 IDE + the SDK) share one central MCP config
// at ~/.gemini/config/mcp_config.json (per antigravity.google/docs/mcp and
// atamel.dev "Where does Antigravity look for MCP Servers?"). It uses the same
// standard JSON `mcpServers` stdio schema (command/args/env) as Gemini/Cursor.
//
// HONESTY: these tests exercise config-path resolution + JSON serialization
// only. End-to-end wiring against a real `agy` install is UNVERIFIED (agy not
// present in CI/this host) — see the PR body.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wireAntigravity,
  clientConfigPath,
  detectClients,
  ALL_CLIENTS,
} from "../../src/install/clients.ts";
import { readClientMcpBlock, detectWiredFlairMcp } from "../../src/doctor-client.ts";

const ENV = { FLAIR_AGENT_ID: "wirebot", FLAIR_URL: "http://127.0.0.1:19926" };

/** This repo's real version, read straight from package.json — the pin the
 *  wire function must write. Independent of mcpServerSpec() so a regression that
 *  unpins BOTH writer and helper still fails here. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
).version;

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-antigravity-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

describe("Antigravity client registration (flair#1209)", () => {
  it("is in the client registry with the `agy` bin", () => {
    const antigravity = ALL_CLIENTS.find((c) => c.id === "antigravity");
    expect(antigravity).toBeDefined();
    expect(antigravity!.bin).toBe("agy");
    expect(antigravity!.label).toBe("Antigravity");
    // detectClients() must surface it (detected flag driven by `agy` on PATH
    // or ~/.gemini/config/mcp_config.json — flair#1417).
    expect(detectClients().some((c) => c.id === "antigravity")).toBe(true);
  });

  it("clientConfigPath resolves to ~/.gemini/config/mcp_config.json", () => {
    expect(clientConfigPath("antigravity")).toBe(
      join(isoHome, ".gemini", "config", "mcp_config.json"),
    );
  });

  it("config path is DISTINCT from Gemini CLI's settings.json (no collision under ~/.gemini)", () => {
    expect(clientConfigPath("antigravity")).not.toBe(clientConfigPath("gemini"));
    expect(clientConfigPath("gemini")).toBe(join(isoHome, ".gemini", "settings.json"));
  });

  it("wires ~/.gemini/config/mcp_config.json with the pinned flair MCP stdio server", () => {
    const res = wireAntigravity(ENV);
    expect(res.ok).toBe(true);
    const cfgPath = join(isoHome, ".gemini", "config", "mcp_config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.flair.command).toBe("npx");
    // Pinned per #1135/#907 — same guarantee the other JSON clients get.
    expect(cfg.mcpServers.flair.args).toEqual(["-y", `@tpsdev-ai/flair-mcp@${PKG_VERSION}`]);
    expect(cfg.mcpServers.flair.env.FLAIR_AGENT_ID).toBe("wirebot");
    expect(cfg.mcpServers.flair.env.FLAIR_URL).toBe(ENV.FLAIR_URL);
  });

  it("does NOT touch Gemini's ~/.gemini/settings.json when wiring Antigravity", () => {
    wireAntigravity(ENV);
    expect(existsSync(join(isoHome, ".gemini", "settings.json"))).toBe(false);
  });

  it("preserves existing mcpServers and is idempotent on re-run", () => {
    const cfgPath = join(isoHome, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(isoHome, ".gemini", "config"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2));

    const first = wireAntigravity(ENV);
    expect(first.ok).toBe(true);
    const cfg1 = JSON.parse(readFileSync(cfgPath, "utf-8"));
    // Pre-existing server survives the merge.
    expect(cfg1.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(cfg1.mcpServers.flair).toBeDefined();

    const second = wireAntigravity(ENV);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("already wired");
    // Byte-for-byte unchanged on the idempotent re-run.
    expect(readFileSync(cfgPath, "utf-8")).toBe(JSON.stringify(cfg1, null, 2) + "\n");
  });

  it("wire success message is HONEST — no confident pickup claim, carries the unverified caveat (flair#1209 review)", () => {
    const res = wireAntigravity(ENV);
    expect(res.ok).toBe(true);
    // Flair wrote the config, but has NOT verified a live agy reads it — so the
    // message must not claim the confident "restart Antigravity to pick it up"
    // the other JSON clients get, and must name the unverified state.
    expect(res.message).toContain("unverified against a real agy");
    expect(res.message).not.toContain("restart Antigravity to pick it up");
  });

  it("stamps FLAIR_CLIENT provenance when the caller sets it", () => {
    wireAntigravity({ ...ENV, FLAIR_CLIENT: "antigravity" });
    const cfgPath = join(isoHome, ".gemini", "config", "mcp_config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.flair.env.FLAIR_CLIENT).toBe("antigravity");
  });

  it("round-trips: doctor's readClientMcpBlock reads back the wired Antigravity block", () => {
    wireAntigravity(ENV);
    const block = readClientMcpBlock("antigravity", isoHome);
    expect(block.present).toBe(true);
    expect(block.agentId).toBe("wirebot");
    expect(block.flairUrl).toBe(ENV.FLAIR_URL);
    expect(block.configPath).toBe(join(isoHome, ".gemini", "config", "mcp_config.json"));
  });

  it("a flair-mcp wired ONLY into Antigravity counts as wired for upgrade detection (#1208 x #1209)", () => {
    wireAntigravity(ENV);
    const wiring = detectWiredFlairMcp(isoHome);
    expect(wiring.wired).toBe(true);
    expect(wiring.pinnedVersion).toBe(PKG_VERSION);
  });
});
