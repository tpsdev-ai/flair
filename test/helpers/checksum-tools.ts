/**
 * checksum-tools.ts — find the real SHA-256 checksum utilities on this host
 * and run them against a sidecar (flair#2664).
 *
 * `shasum` is perl's (macOS, and the perl package on Linux). `sha256sum` is
 * GNU coreutils on Linux; macOS ships a BSD `sha256sum` that reads only
 * unescaped lines. `escapes` says whether a tool reads the backslash and
 * line-feed escapes formatBackupDigest writes for unusual file names.
 */
import { spawnSync } from "node:child_process";

export interface ChecksumTool {
  /** How the tool is named in test titles. */
  readonly label: string;
  /** The command that checks a sidecar, without the sidecar argument. */
  readonly check: readonly string[];
  readonly escapes: boolean;
}

export function findChecksumTools(): { shasum?: ChecksumTool; sha256sum?: ChecksumTool } {
  const tools: { shasum?: ChecksumTool; sha256sum?: ChecksumTool } = {};
  const shasum = Bun.which("shasum");
  if (shasum) tools.shasum = { label: "shasum -a 256 -c", check: [shasum, "-a", "256", "-c"], escapes: true };
  const sha256sum = Bun.which("sha256sum");
  if (sha256sum) {
    const version = spawnSync(sha256sum, ["--version"], { encoding: "utf8" });
    const gnu = /GNU coreutils/.test(`${version.stdout ?? ""}${version.stderr ?? ""}`);
    tools.sha256sum = { label: gnu ? "GNU sha256sum -c" : "non-GNU sha256sum -c", check: [sha256sum, "-c"], escapes: gnu };
  }
  return tools;
}

/** Run `tool` on `sidecarName` from `dir`, with a minimal environment. */
export function runChecksumTool(tool: ChecksumTool, dir: string, sidecarName: string): { status: number | null; output: string } {
  const result = spawnSync(tool.check[0]!, [...tool.check.slice(1), sidecarName], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
