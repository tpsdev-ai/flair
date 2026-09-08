/**
 * upgrade-plain-tree-wiring.test.ts — flair#1109 (a)
 *
 * Proves `flair upgrade --check --tree` actually takes the plain-tree lane
 * (banner, tree version, scope footer, plan) and that `--tree` on a git
 * checkout refuses. Isolated because it imports `src/cli.ts`.
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { program } = await import("../../src/cli.ts");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function writePackedTree(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/flair", version }));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(dir, "flair"), "#!/bin/sh\nexec node dist/cli.js \"$@\"\n");
}

async function runUpgradeCheck(argv: string[]): Promise<{ logs: string[]; errs: string[]; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map((a) => String(a)).join(" "));
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ version: "0.99.0" }), { status: 200 })
  ) as unknown as typeof fetch;
  let exitCode: number | null = null;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${exitCode})`);
  }) as typeof process.exit);

  try {
    await program.parseAsync(["node", "flair", ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("process.exit(")) throw err;
  } finally {
    globalThis.fetch = origFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exitCode };
}

describe("flair upgrade plain-tree wiring", () => {
  const fixtures: string[] = [];
  afterEach(() => {
    for (const dir of fixtures.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upgrade --check --tree on a packed extract prints the tarball-swap plan", async () => {
    const tree = realpathSync(mkdtempSync(join(tmpdir(), "flair-plain-tree-wire-")));
    fixtures.push(tree);
    writePackedTree(tree, "0.36.0");

    const { logs, exitCode } = await runUpgradeCheck(["upgrade", "--check", "--tree", tree]);
    expect(exitCode).toBeNull();
    const text = logs.join("\n");
    expect(text).toContain(`Plain-tree install: ${tree}  (0.36.0)`);
    expect(text).toContain("@tpsdev-ai/flair: 0.36.0 → 0.99.0");
    expect(text).toContain("in-place tarball swap");
    expect(text).toContain("preserve launcher/overlay: flair");
    expect(text).toContain(`Scope: plain-tree at ${tree}`);
    expect(text).toContain(`Run: flair upgrade --tree ${tree}`);
    expect(text).not.toContain("`flair upgrade` only upgrades the npm-global packages");
  });

  test("upgrade --check --tree on this git checkout refuses", async () => {
    const { errs, exitCode } = await runUpgradeCheck(["upgrade", "--check", "--tree", repoRoot]);
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("git checkout");
    expect(errs.join("\n")).toContain("tarball-swap lane would overwrite it");
  });
});
