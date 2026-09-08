/** Types for scripts/ci/check-mcp-client-wiring.mjs (flair#908). */

import type { ClientId } from "../../src/install/clients.ts";

export const EXIT_OK: 0;
export const EXIT_FAIL: 1;
export const EXIT_DID_NOT_RUN: 2;

export const FLAIR_MCP_PACKAGE: "@tpsdev-ai/flair-mcp";
export const PI_FLAIR_PACKAGE: "@tpsdev-ai/pi-flair";
export const CLOBBER_MARKER_SERVER: "preexisting-other";

export type PinKind = "mcp-json" | "mcp-toml" | "pi-packages";

export interface SupportedClient {
  id: ClientId;
  label: string;
  bin: string;
  relativeConfig: string;
  pinKind: PinKind;
  exercise: boolean;
  skipReason?: string;
}

export const SUPPORTED_CLIENTS: SupportedClient[];

export interface WiringSummary {
  wired: string[];
  notWired: string[];
  skipped: string[];
  hasHeading: boolean;
}

export type ClientReportStatus = "wired" | "not-wired" | "skipped" | "silent" | "no-summary" | "ambiguous";

export interface ClientReport {
  status: ClientReportStatus;
  buckets: string[];
  hasHeading: boolean;
}

export interface PinCheck {
  ok: boolean;
  reason: string;
}

export interface PinRead {
  spec: string | null;
  error: string | null;
}

export interface ClobberCheck {
  ok: boolean;
  reason: string;
}

export interface ParsedArgs {
  flair: string;
  version: string;
  port: string;
  agent: string;
  help?: boolean;
  unknown?: string;
}

export interface RunFlairOpts {
  flair: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}

export interface RunFlairResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
  output: string;
}

export function configPath(home: string, client: SupportedClient): string;
export function wiringSummarySection(output: string): string;
export function parseWiringSummary(output: string): WiringSummary;
export function classifyClientReport(output: string, client: SupportedClient): ClientReport;
export function pinCheck(spec: string | null | undefined, packageName: string, version: string): PinCheck;
export function readJsonMcpPin(raw: string): PinRead;
export function readTomlMcpPin(raw: string): PinRead;
export function readPiPin(raw: string): PinRead;
export function readWrittenPin(raw: string, client: SupportedClient): PinRead;
export function expectedPackage(client: SupportedClient): string;
export function clobberClaudeFixture(): {
  numStartups: number;
  theme: string;
  mcpServers: Record<string, { command: string; args: string[] }>;
};
export function clobberSurvived(raw: string): ClobberCheck;
export function parseArgs(argv: string[]): ParsedArgs;
export function binOnPath(bin: string, pathEnv: string): boolean;
export function runFlair(opts: RunFlairOpts): RunFlairResult;
export function installPrefixFromFlair(flairPath: string): string;
export function main(argv?: string[]): number;
