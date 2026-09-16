/** Types for scripts/ci/check-plugin-canary.mjs (flair#1338). */

export const EXIT_OK: 0;
export const EXIT_FAIL: 1;
export const EXIT_DID_NOT_RUN: 2;

export const FLAIR_MCP_PACKAGE: "@tpsdev-ai/flair-mcp";
export const FLAIR_CLIENT_PACKAGE: "@tpsdev-ai/flair-client";
export const REQUIRED_TOOLS: readonly ["memory_store", "memory_get", "bootstrap"];
export const VERSION_RE: RegExp;
export const REPO_ROOT: string;
export const WORKSPACE_PACKAGES: string;

export interface ParsedArgs {
  version: string;
  flairUrl: string;
  agent: string;
  keyPath: string;
  flairBin: string;
  prefix: string;
  keep: boolean;
  help: boolean;
  unknown: string;
}

export interface PinRead {
  spec: string | null;
  error: string | null;
}

export interface PinCheck {
  ok: boolean;
  reason: string;
}

export interface InstalledVersion {
  version: string | null;
  path: string;
  error: string | null;
}

export interface PluginWired {
  hasScript: boolean;
  hasId: boolean;
  hasOutcome: boolean;
  hasContinue: boolean;
  wired: boolean;
}

export interface HostEnv {
  agentId: string;
  flairUrl: string;
  keyPath?: string;
}

export function parseArgs(argv: string[]): ParsedArgs;
export function registrySpec(packageName: string, version: string): string;
export function documentedHostConfig(version: string, env: HostEnv): {
  mcpServers: {
    flair: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
};
export function readDocumentedPin(config: unknown): PinRead;
export function pinCheck(spec: string | null | undefined, packageName: string, version: string): PinCheck;
export function assertPublishedResolve(resolvedPath: string, prefix: string): PinCheck;
export function readInstalledVersion(prefix: string, packageName: string): InstalledVersion;
export function pluginCanaryWired(yml: string): PluginWired;
export function main(argv?: string[]): Promise<number>;
