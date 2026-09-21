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
import { join } from "node:path";
import {
  ALL_CLIENTS,
  clientConfigPath,
  type ClientId,
  type WireEnv,
} from "../install/clients.js";
import {
  checkSessionStartHook,
  extractFlairMcpPin,
  extractFlairPackagePins,
  isFlairHookCommand,
  readClientMcpBlock,
} from "../doctor-client.js";
import { isUnsafeAdapterPin } from "./stale-client-pin.js";
import {
  hookInstallHint,
  hookSettingsPath,
  repinSessionStartHook,
  SUPPORTED_HARNESSES,
  type Harness,
} from "../hook-install.js";
import { flairCliVersion, isResolvedVersion } from "./mcp-spec.js";
import { isPinDowngrade } from "./upgrade-status.js";

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
  action: "update" | "noop" | "skip" | "hold";
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

export function staleMcpClientPins(
  homeDir: string,
  expectedVersion: string = flairCliVersion(),
): OwnedPinReading[] {
  return staleOwnedPins(homeDir, expectedVersion).filter((r) => r.target.kind === "mcp-client");
}

export type UnsafeWiredPinSource = OwnedPinKind | "package.json";

/**
 * A pre-0.18.0 `@tpsdev-ai/flair-mcp` or `@tpsdev-ai/flair-client` pin
 * actually written in a wired host config or the cwd package.json.
 *
 * Independent of "pin !== CLI version". A current `flair-mcp` pin next to
 * `flair-client@0.17.0` in package.json is still a silent-drop host
 * (flair#1383).
 */
export interface UnsafeWiredPin {
  source: UnsafeWiredPinSource;
  id: string;
  surface: string;
  package: "flair-mcp" | "flair-client";
  version: string;
}

/**
 * Read the pins that are actually installed in wired hosts' configs
 * (and the cwd package.json) and return those older than 0.18.0.
 */
export function findUnsafeWiredPins(homeDir: string, cwd?: string): UnsafeWiredPin[] {
  const found: UnsafeWiredPin[] = [];
  const seen = new Set<string>();
  const add = (pin: UnsafeWiredPin): void => {
    const key = `${pin.source}:${pin.id}:${pin.package}@${pin.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(pin);
  };

  for (const target of listOwnedPinTargets(homeDir)) {
    const reading = readOwnedPin(target, homeDir);
    if (!reading.present) continue;
    const text = readFileText(target.path) ?? "";
    const surface = target.kind === "mcp-client" ? "MCP server" : "SessionStart hook";
    for (const pin of extractFlairPackagePins(text)) {
      if (!isUnsafeAdapterPin(pin.version)) continue;
      add({
        source: target.kind,
        id: target.id,
        surface,
        package: pin.package,
        version: pin.version,
      });
    }
  }

  if (cwd) {
    const pkgPath = join(cwd, "package.json");
    const text = readFileText(pkgPath);
    if (text) {
      for (const pin of extractFlairPackagePins(text)) {
        if (!isUnsafeAdapterPin(pin.version)) continue;
        add({
          source: "package.json",
          id: "cwd",
          surface: "package.json",
          package: pin.package,
          version: pin.version,
        });
      }
    }
  }
  return found;
}

/**
 * What `flair upgrade` prints from a refresh result.
 *
 * A failed `client.wire` is `action: "skip"` + `ok: false` (same shape as a
 * fail-closed hook re-pin). Filtering on `action !== "skip"` alone dropped
 * that failure, left the pin stale, and printed nothing (Bugbot on #1485).
 * Failures always surface. MCP no-ops/updates still print; hook no-ops stay quiet.
 */
export function ownedPinRefreshShouldReport(r: OwnedPinRefreshResult): boolean {
  if (!r.ok) return true;
  // A HELD pin (a refresh that would LOWER an owned pin) always prints — the
  // operator needs to see why the pin was not refreshed (flair#1778 D4).
  if (r.action === "hold") return true;
  if (r.target.kind === "mcp-client") return r.action !== "skip";
  return r.action === "update";
}

export function staleHookRemedy(readings: readonly OwnedPinReading[]): string {
  const harnesses = readings
    .filter((r) => r.target.kind === "session-start-hook")
    .map((r) => r.target.id as Harness);
  if (harnesses.length === 0) return "flair hook install";
  return [...new Set(harnesses)].map((h) => hookInstallHint(h)).join(" ; ");
}

export type PinDirection = "ahead" | "behind" | "unknown";

/**
 * Direction of an owned pin relative to `target` (the version a refresh would
 * write — the running CLI's). Uses the ONE comparison #1786 introduced
 * (`isPinDowngrade`) so no call site re-derives the ordering itself.
 *
 *   pin > target           -> "ahead"   (writing target over it would LOWER it)
 *   pin < target           -> "behind"
 *   equal / not comparable -> "unknown"
 */
export function pinDirection(pin: string | null | undefined, target: string | null | undefined): PinDirection {
  if (isPinDowngrade(pin, target)) return "ahead";
  if (isPinDowngrade(target, pin)) return "behind";
  return "unknown";
}

export interface SessionStartHookPinFinding {
  reading: OwnedPinReading;
  direction: PinDirection;
}

/**
 * Stale SessionStart-hook pins, each annotated with its direction — the ONE
 * place a caller goes for "which way is this pin off" (flair#1778 follow-up).
 * SessionStart hooks only: an MCP-client pin that is ahead is a different
 * surface with its own rendering.
 */
export function sessionStartHookPinFindings(
  homeDir: string,
  expectedVersion: string = flairCliVersion(),
): SessionStartHookPinFinding[] {
  return staleSessionStartHookPins(homeDir, expectedVersion).map((reading) => ({
    reading,
    direction: pinDirection(reading.pin, expectedVersion),
  }));
}

/**
 * The ONE hold line a refresh prints when it refuses to lower an owned pin.
 * Phrased neutrally ("a pin is never lowered") because both `flair upgrade`'s
 * refresh and `flair doctor --fix` print it — no per-caller copy.
 */
function heldPinMessage(id: string, pin: string, runningCli: string): string {
  return `${id}: keeping pinned ${pin} (running CLI ${runningCli} is older — a pin is never lowered)`;
}

/**
 * The ONE SessionStart-hook re-pin guard (flair#1778 D4), shared by
 * `flair upgrade`'s pin refresh and `flair doctor --fix`.
 *
 * Rebuilds an already-wired hook to the running CLI's version, but never
 * LOWERS an owned pin: when the running CLI is older than the pin present
 * (`isPinDowngrade`), it HOLDS — `action: "hold"`, with a line naming both
 * versions — instead of rewriting. There is no second copy of this decision:
 * `flair doctor --fix`'s stale-hook repair routes through here too, so a
 * `doctor --fix` on an ahead pin holds exactly as the upgrade refresh does
 * (flair#1778 slice-1 follow-up, N4).
 *
 * NEVER adds a hook (repinSessionStartHook's contract); a home with no hook is
 * a clean skip.
 */
export function repinSessionStartHookGuarded(
  homeDir: string,
  harness: Harness,
  target?: OwnedPinTarget,
): OwnedPinRefreshResult {
  const resolved: OwnedPinTarget = target ?? listOwnedPinTargets(homeDir).find(
    (t) => t.kind === "session-start-hook" && t.id === harness,
  ) ?? {
    kind: "session-start-hook",
    id: harness,
    path: hookSettingsPath(homeDir, harness),
    displayPath: hookSettingsPath(homeDir, harness),
  };
  const wouldWrite = flairCliVersion();
  const existing = readOwnedPin(resolved, homeDir).pin;
  if (isPinDowngrade(existing, wouldWrite)) {
    return {
      target: resolved,
      action: "hold",
      ok: true,
      message: heldPinMessage(resolved.id, existing as string, wouldWrite),
    };
  }
  const repin = repinSessionStartHook(homeDir, harness);
  return {
    target: resolved,
    action: repin.action,
    ok: repin.ok,
    message: repin.message,
  };
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
        // flair#1778 D4: never re-pin a hook DOWN. The guard lives in ONE place
        // (repinSessionStartHookGuarded) so `flair doctor --fix` shares it
        // rather than growing a second implementation.
        results.push(repinSessionStartHookGuarded(homeDir, target.id as Harness, target));
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
      // flair#1778 D4: the wire writes the running CLI's version; never let the
      // refresh LOWER a pin that is ahead.
      const wouldWritePin = flairCliVersion();
      if (isPinDowngrade(before, wouldWritePin)) {
        results.push({
          target,
          action: "hold",
          ok: true,
          message: heldPinMessage(target.id, before as string, wouldWritePin),
        });
        continue;
      }
      const wired = client.wire(env);
      const after = extractFlairMcpPin(readFileText(target.path) ?? "");
      // Failed write stays skip+ok:false (fail-closed, like hook re-pin).
      // ownedPinRefreshShouldReport treats !ok as printable — do not recode
      // this as a quiet skip.
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
