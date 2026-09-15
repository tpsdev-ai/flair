/**
 * flair#1684 — the local npm registry shim builds its outbound URL from the
 * request path, so CodeQL flagged the proxy as SSRF. The fix is a shape guard:
 * only an explicit allow-list of lockstep `@tpsdev-ai/<name>` packages, and
 * only a packument, a `latest`/`X.Y.Z` version manifest, or a matching tarball,
 * may be forwarded. Everything else is refused with 404.
 *
 * These tests pin the guard at the decision point and over a real HTTP
 * request, so a future edit that widens the proxy has to delete a test.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCKSTEP_PACKAGE_NAMES,
  resolveUpstreamPath,
} from "../../scripts/ci/local-npm-registry.mjs";

type ShimChild = ChildProcessByStdio<null, Readable, Readable>;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci", "local-npm-registry.mjs");

const tmp = mkdtempSync(join(tmpdir(), "local-npm-registry-ssrf-"));
const tarballPath = join(tmp, "tpsdev-ai-flair-0.54.1.tgz");
writeFileSync(tarballPath, "not a real tarball");

const children: ShimChild[] = [];
const servers: Server[] = [];

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr !== "object" || addr === null) {
        probe.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

function startFakeUpstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "@tpsdev-ai/flair",
          "dist-tags": { latest: "0.54.1" },
          versions: {},
        }),
      );
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("fake upstream did not bind"));
        return;
      }
      servers.push(server);
      resolve({ server, port: addr.port });
    });
  });
}

function startShim(upstream: string): Promise<{ child: ShimChild; port: number }> {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        SCRIPT,
        "--port",
        String(port),
        "--package",
        "@tpsdev-ai/flair",
        "--version",
        "0.54.1",
        "--tarball",
        tarballPath,
        "--package-json",
        join(REPO_ROOT, "package.json"),
        "--upstream",
        upstream,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);

    let out = "";
    const timer = setTimeout(() => {
      reject(new Error(`registry did not print READY within 15s:\n${out}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/^READY (\d+)/m);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`registry exited early (${code}):\n${out}`));
    });
  });
}

describe("resolveUpstreamPath — allow-listed lockstep shapes", () => {
  test("the allow-list is non-empty (positive control)", () => {
    expect(LOCKSTEP_PACKAGE_NAMES.size).toBeGreaterThan(0);
  });

  test("forwards a lockstep packument", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/flair")).toBe("/@tpsdev-ai/flair");
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/")).toBe("/@tpsdev-ai/flair");
  });

  test("forwards a lockstep semver or latest manifest", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/0.54.1")).toBe("/@tpsdev-ai/flair/0.54.1");
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/latest")).toBe("/@tpsdev-ai/flair/latest");
  });

  test("forwards a lockstep tarball", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/flair-tool-descriptors/-/flair-tool-descriptors-0.54.1.tgz")).toBe(
      "/@tpsdev-ai/flair-tool-descriptors/-/flair-tool-descriptors-0.54.1.tgz",
    );
  });

  test("refuses another scope", () => {
    expect(resolveUpstreamPath("/@evil/flair")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai-evil/flair")).toBeNull();
  });

  test("refuses a package outside the lockstep allow-list", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/cursor-flair")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/cursor-wake-runner")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/totally-new-package")).toBeNull();
  });

  test("refuses a version that is neither semver nor latest", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/not-a-version")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/1.2")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/1.2.3.4")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/0.54.1-beta.1")).toBeNull();
  });

  test("refuses path traversal, extra segments, and unscoped paths", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/../../etc/passwd")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/../../etc/passwd")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/-/../flair-0.54.1.tgz")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/0.54.1/extra")).toBeNull();
    expect(resolveUpstreamPath("/lodash")).toBeNull();
    expect(resolveUpstreamPath("/-/npm/v1/security/advisories/bulk")).toBeNull();
  });

  test("refuses a tarball whose filename does not match its package/version", () => {
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/-/flair-not-a-version.tgz")).toBeNull();
    expect(resolveUpstreamPath("/@tpsdev-ai/flair/-/other-0.54.1.tgz")).toBeNull();
  });
});

describe("local-npm-registry proxy refuses non-allow-listed requests over HTTP", () => {
  test("404s another scope/package/path, 200s an allow-listed packument", async () => {
    const upstream = await startFakeUpstream();
    const shim = await startShim(`http://127.0.0.1:${upstream.port}`);
    const base = `http://127.0.0.1:${shim.port}`;

    const refused = [
      "/@evil/flair",
      "/@tpsdev-ai/cursor-flair",
      "/@tpsdev-ai/totally-new-package",
      "/@tpsdev-ai/flair/not-a-version",
      "/@tpsdev-ai/flair/0.54.1/extra",
      "/lodash",
      "/-/npm/v1/security/advisories/bulk",
    ];
    for (const path of refused) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }

    // Positive control: an allow-listed package still reaches the upstream.
    // This is a different package than the shim's override, so it exercises
    // the proxy rather than the local tarball/packument handlers.
    const allowed = await fetch(`${base}/@tpsdev-ai/flair-tool-descriptors`);
    expect(allowed.status).toBe(200);
  });
});
