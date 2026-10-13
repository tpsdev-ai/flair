/**
 * node-runtime.ts — the runtime the flair CLI and Harper run under in tests.
 *
 * flair#2570: every SHIPPED path runs the CLI under node (the package `bin` is
 * `dist/cli-shim.cjs`, `#!/usr/bin/env node`, and `flair init` spawns Harper
 * with `process.execPath`, so an installed `flair` always starts Harper under
 * node). A test that spawns the CLI with `process.execPath` (or a literal
 * `"bun"`) runs the CLI — and therefore the Harper it starts — under Bun, which
 * exercises a different module loader (`vm.SourceTextModule`) than the shipped
 * one and can raise `ResourceLoadError` at component load.
 *
 * `nodeBin()` is the shared runtime helper for a CLI or Harper child, so a child
 * spawned through it does not take the Bun loader path. It does not return a Bun
 * binary: `NODE_BIN` is honoured only when it does not name Bun, and the
 * in-process `process.execPath` is used only when it is not Bun.
 */
export function nodeBin(): string {
  const configured = process.env.NODE_BIN?.trim();
  if (configured && !/bun/i.test(configured)) return configured;
  if (process.execPath && !process.execPath.includes("bun")) return process.execPath;
  return "node";
}
