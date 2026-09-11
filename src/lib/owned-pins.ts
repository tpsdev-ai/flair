/**
 * owned-pins.ts — flair#1485
 *
 * The single catalogue of files `flair init` / `flair hook install` write a
 * pinned `@tpsdev-ai/flair-mcp@<version>` into. `flair upgrade` refreshes
 * every entry that is already wired; `flair doctor` reads the same list to
 * decide whether a pin is current.
 *
 * Two kinds:
 *   mcp-client         — ALL_CLIENTS kind:"mcp" config paths
 *   session-start-hook — SUPPORTED_HARNESSES hook settings paths
 *
 * Adding a client to ALL_CLIENTS or a harness to SUPPORTED_HARNESSES adds
 * it here automatically — no second list to forget on the next upgrade.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  ALL_CLIENTS,
  clientConfigPath,
  type ClientId,
  type WireEnv,
} from "../install/clients.js";
import {
  checkSessionStartHook,
  extractFlairMcpPin,
  isFlairHookCommand,
  readClientMcpBlock,
} from "../doctor-client.js";
import {
  hookInstallHint,
  hookSettingsPath,
  repinSessionStartHook,
  SUPPORTED_HARNESSES,
  type Harness,
} from "../hook-install.js";
import { flairCliVersion, isResolvedVersion } from "./mcp-spec.js";

export type OwnedPinKind = "mcp-client" | "session-start-hook";

export interface OwnedPinTarget {
  kind: OwnedPinKind;
  id: string;
  path: string;
  displayPath: string;
}

export interface OwnedPinReading {
  target: OwnedPinTarget;
  /** True when this file already carries Flair wiring we may refresh / judge. */
  present: boolean;
  /** Concrete `@tpsdev-ai/flair-mcp@<ver>` pin, or null if unpinned / absent. */
  pin: string | null;
}

export interface OwnedPinRefreshResult {
  target: OwnedPinTarget;
  action: "update" | "noop" | "skip";
  ok: boolean;
  message: string;
}

export interface RefreshOwnedPinsOptions {
  homeDir: string;
  /** Required to refresh MCP client pins. Hook re-pin reads the agent from the hook. */
  agentId?: string | null;
  flairUrl?: string;
}

function withHome<T>(homeDir: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function displayHomePath(homeDir: string, path: string): string {
  if (path.startsWith(homeDir)) return "~" + path.slice(homeDir.length);
  return path;
}

/**
 * Every file Flair pins. Order: MCP clients (registry order), then hooks
 * (harness registry order). Upgrade and doctor both iterate this.
 */
export function listOwnedPinTargets(homeDir: string): OwnedPinTarget[] {
  return withHome(homeDir, () => {
    const targets: OwnedPinTarget[] = [];
    for (const client of ALL_CLIENTS) {
      if (client.kind !== "mcp") continue;
      const path = clientConfigPath(client.id);
      targets.push({
        kind: "mcp-client",
        id: client.id,
        path,
        displayPath: displayHomePath(homeDir, path),
      });
    }
    for (const harness of SUPPORTED_HARNESSES) {
      const path = hookSettingsPath(homeDir, harness);
      targets.push({
        kind: "session-start-hook",
        id: harness,
        path,
        displayPath: displayHomePath(homeDir, path),
      });
    }
    return targets;
  });
}

function readFileText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function readOwnedPin(target: OwnedPinTarget, homeDir: string): OwnedPinReading {
  if (target.kind === "session-start-hook") {
    const hook = checkSessionStartHook(homeDir, target.path);
    const present = !!(hook.present && hook.command && isFlairHookCommand(hook.command));
    return {
      target,
      present,
      pin: present ? extractFlairMcpPin(hook.command ?? "") : null,
    };
  }
  const block = readClientMcpBlock(target.id as ClientId, homeDir);
  const text = readFileText(target.path) ?? "";
  return {
    target,
    present: block.present,
    pin: block.present ? extractFlairMcpPin(text) : null,
  };
}

export function readOwnedPins(homeDir: string): OwnedPinReading[] {
  return listOwnedPinTargets(homeDir).map((t) => readOwnedPin(t, homeDir));
}

/**
 * Wired pins whose concrete version is not the installed CLI version.
 * Unpinned / absent entries are not stale — they are a different check.
 */
export function staleOwnedPins(
  homeDir: string,
  expectedVersion: string = flairCliVersion(),
): OwnedPinReading[] {
  if (!isResolvedVersion(expectedVersion)) return [];
  return readOwnedPins(homeDir).filter(
    (r) => r.present && r.pin !== null && r.pin !== expectedVersion,
  );
}

export function staleSessionStartHookPins(
  homeDir: string,
  expectedVersion: string = flairCliVersion(),
): OwnedPinReading[] {
  return staleOwnedPins(homeDir, expectedVersion).filter((r) => r.target.kind === "session-start-hook");
}

export function staleHookRemedy(readings: readonly OwnedPinReading[]): string {
  const harnesses = readings
    .filter((r) => r.target.kind === "session-start-hook")
    .map((r) => r.target.id as Harness);
  if (harnesses.length === 0) return "flair hook install";
  return [...new Set(harnesses)].map((h) => hookInstallHint(h)).join(" ; ");
}

/**
 * Refresh every already-wired owned pin to the running CLI's spec.
 *
 * MCP client pins need `agentId` (the wire functions rewrite the env block).
 * SessionStart hooks do not — `repinSessionStartHook` reads the agent from
 * the existing command. A missing agentId therefore skips MCP only; it must
 * not skip hooks (that was the early-return hole in the inline upgrade path).
 *
 * NEVER adds a hook or wires a new client.
 */
export function refreshOwnedPins(opts: RefreshOwnedPinsOptions): OwnedPinRefreshResult[] {
  const { homeDir } = opts;
  const flairUrl = opts.flairUrl ?? "http://127.0.0.1:9926";
  const agentId = opts.agentId ?? null;
  const targets = listOwnedPinTargets(homeDir);
  const results: OwnedPinRefreshResult[] = [];

  return withHome(homeDir, () => {
    for (const target of targets) {
      if (target.kind === "session-start-hook") {
        const harness = target.id as Harness;
        const repin = repinSessionStartHook(homeDir, harness);
        results.push({
          target,
          action: repin.action,
          ok: repin.ok,
          message: repin.message,
        });
        continue;
      }

      const block = readClientMcpBlock(target.id as ClientId, homeDir);
      if (!block.present) {
        results.push({
          target,
          action: "skip",
          ok: true,
          message: `${target.id}: not wired — skip`,
        });
        continue;
      }
      if (!agentId) {
        results.push({
          target,
          action: "skip",
          ok: true,
          message: `${target.id}: no agent id — skip MCP pin refresh`,
        });
        continue;
      }
      const client = ALL_CLIENTS.find((c) => c.id === target.id);
      if (!client) {
        results.push({
          target,
          action: "skip",
          ok: true,
          message: `${target.id}: not in client registry — skip`,
        });
        continue;
      }
      const env: WireEnv = {
        FLAIR_AGENT_ID: agentId,
        FLAIR_URL: flairUrl,
        FLAIR_CLIENT: target.id,
      };
      const before = extractFlairMcpPin(readFileText(target.path) ?? "");
      const wired = client.wire(env);
      const after = extractFlairMcpPin(readFileText(target.path) ?? "");
      const action =
        !wired.ok ? "skip"
          : before !== after ? "update"
            : "noop";
      results.push({
        target,
        action,
        ok: wired.ok,
        message: wired.message,
      });
    }
    return results;
  });
}
