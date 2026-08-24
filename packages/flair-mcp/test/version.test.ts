import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolvePackageVersion,
  resolvePackageVersionFrom,
  serverInfo,
  UNKNOWN_VERSION,
} from "../src/version.ts";

/**
 * flair#1314 — MCP `initialize` advertised serverInfo.version `0.1.0` while
 * the published package was ~0.46. Client UIs (Claude Code /mcp, Cursor)
 * display that string. These tests lock that the version comes from this
 * package's package.json, and that the initialize handshake reports it.
 */

const PKG_ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")) as {
  name: string;
  version: string;
};

describe("resolvePackageVersion", () => {
  test("reads this package's package.json version", () => {
    expect(pkg.name).toBe("@tpsdev-ai/flair-mcp");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(resolvePackageVersion()).toBe(pkg.version);
  });

  test("is not the old hardcoded 0.1.0", () => {
    expect(resolvePackageVersion()).not.toBe("0.1.0");
  });

  test("a startDir with no @tpsdev-ai/flair-mcp package.json falls through to unknown", () => {
    // Filesystem root has no matching package — proves the walk terminates
    // and does not invent a version.
    expect(resolvePackageVersionFrom("/")).toBe(process.env.npm_package_version ?? UNKNOWN_VERSION);
  });
});

describe("serverInfo", () => {
  test("name is flair and version is the package version", () => {
    expect(serverInfo()).toEqual({ name: "flair", version: pkg.version });
  });
});

describe("initialize handshake", () => {
  test("reports the package version in serverInfo", async () => {
    const server = new McpServer(serverInfo());
    const client = new Client({ name: "flair-mcp-version-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerVersion()).toEqual({ name: "flair", version: pkg.version });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("index.ts construction site", () => {
  test("McpServer is constructed from serverInfo(), not a hardcoded version", () => {
    const src = readFileSync(join(PKG_ROOT, "src", "index.ts"), "utf-8");
    expect(src).toContain("new McpServer(serverInfo())");
    expect(src).not.toMatch(/version:\s*["']0\.1\.0["']/);
  });
});
