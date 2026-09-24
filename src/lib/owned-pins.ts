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

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { withHome } from "./home.js";
import {
  ALL_CLIENTS,
  clientConfigPath,
  repinCodexPin,
  repinJsonMcpPin,
  type ClientId,
} from "../install/clients.js";
import {
  checkSessionStartHook,
  isFlairHookCommand,
  readClientMcpBlock,
} from "../doctor-client.js";
import {
  decodeWiringSpec,
  decodeWiringSpecs,
  isComparableWiringPin,
  wiringPinString,
} from "./wiring-spec.js";
import { isUnsafeAdapterPin } from "./stale-client-pin.js";
import { type ConfigSectionOptions } from "./config-critical-section.js";
import {
  hookInstallHint,
  hookSettingsPath,
  repinSessionStartHook,
  SUPPORTED_HARNESSES,
  type Harness,
} from "../hook-install.js";
import { flairCliVersion, isResolvedVersion, FLAIR_MCP_PACKAGE } from "./mcp-spec.js";
import { comparePinVersions, pinWriteWouldLowerOrIsUnknown } from "./upgrade-status.js";

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
  /** STRUCTURAL presence, separate from identity (flair#1834 A1 item 1): true
   *  when a Flair MCP entry exists at all, whether or not it names a
   *  FLAIR_AGENT_ID. A refresh/pin finding keys off THIS (a pin refresh
   *  preserves whatever identity the entry carries); doctor's wiring offer
   *  keeps `present` (entry-without-identity stays distinct from no-entry). */
  entryExists: boolean;
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
  /**
   * Restrict the refresh to specific targets (kind + id). When set, ONLY these
   * targets are visited (flair#1779).
   *
   * `flair doctor --fix` uses this to re-pin a behind MCP-client block through
   * the SAME guarded writer the upgrade refresh uses. flair#1834 A1 removed the
   * per-target `agentId`/`flairUrl` overrides: the JSON writer is now pin-only,
   * so it preserves each entry's OWN identity rather than rewriting it from a
   * host-wide guess. Only kind/id remain.
   */
  targets?: ReadonlyArray<{ kind: OwnedPinKind; id: string }>;
  /**
   * TEST-ONLY: stage barriers forwarded to the pin-only writers' primitive
   * (see `config-critical-section.ts`). Inert in production; used by fixtures
   * that must inject a refused write after the decision.
   */
  testHooks?: ConfigSectionOptions["testHooks"];
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
      entryExists: present,
      pin: present ? wiringPinString(decodeWiringSpec(hook.command ?? "", FLAIR_MCP_PACKAGE)) : null,
    };
  }
  const block = readClientMcpBlock(target.id as ClientId, homeDir);
  const text = readFileText(target.path) ?? "";
  return {
    target,
    present: block.present,
    entryExists: block.entryExists,
    // Read the pin whenever the ENTRY exists — an entry without an identity is
    // still a pin we own and may refresh (flair#1834 A1 item 1).
    pin: block.entryExists ? wiringPinString(decodeWiringSpec(text, FLAIR_MCP_PACKAGE)) : null,
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
    (r) => r.entryExists && r.pin !== null && r.pin !== expectedVersion,
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
    if (!reading.entryExists) continue;
    const text = readFileText(target.path) ?? "";
    const surface = target.kind === "mcp-client" ? "MCP server" : "SessionStart hook";
    for (const pkg of ["flair-mcp", "flair-client"] as const) {
      for (const spec of decodeWiringSpecs(text, `@tpsdev-ai/${pkg}`)) {
        // flair#1778 2c-i-a1: only a CONCRETE pin can be an unsafe (< 0.18.0)
        // adapter pin; a range/tag/unsupported/malformed spec is present-not-
        // comparable and is neither dropped nor treated as unsafe.
        if (!isComparableWiringPin(spec)) continue;
        const version = spec.token.value as string;
        if (!isUnsafeAdapterPin(version)) continue;
        add({
          source: target.kind,
          id: target.id,
          surface,
          package: pkg,
          version,
        });
      }
    }
  }

  if (cwd) {
    const pkgPath = join(cwd, "package.json");
    const text = readFileText(pkgPath);
    if (text) {
      for (const pkg of ["flair-mcp", "flair-client"] as const) {
        for (const spec of decodeWiringSpecs(text, `@tpsdev-ai/${pkg}`)) {
          if (!isComparableWiringPin(spec)) continue;
          const version = spec.token.value as string;
          if (!isUnsafeAdapterPin(version)) continue;
          add({
            source: "package.json",
            id: "cwd",
            surface: "package.json",
            package: pkg,
            version,
          });
        }
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
 * write — the running CLI's). Uses the ONE comparison (`comparePinVersions`) so
 * no call site re-derives the ordering itself.
 *
 *   pin > target           -> "ahead"   (writing target over it would LOWER it)
 *   pin < target           -> "behind"
 *   equal / not comparable -> "unknown"
 */
export function pinDirection(pin: string | null | undefined, target: string | null | undefined): PinDirection {
  const cmp = comparePinVersions(pin, target);
  if (cmp === null) return "unknown";
  if (cmp > 0) return "ahead";
  if (cmp < 0) return "behind";
  return "unknown"; // equal — not stale, but not a direction either
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

/** A stale MCP-client pin, annotated with its direction (flair#1789). */
export interface McpClientPinFinding {
  reading: OwnedPinReading;
  direction: PinDirection;
}

/**
 * Stale MCP-client pins, each annotated with its direction — the client-side
 * twin of `sessionStartHookPinFindings`, so `flair doctor`'s install-health
 * catalog can give an MCP pin the same three-valued treatment as the
 * SessionStart hook (flair#1789).
 */
export function mcpClientPinFindings(
  homeDir: string,
  expectedVersion: string = flairCliVersion(),
): McpClientPinFinding[] {
  return staleMcpClientPins(homeDir, expectedVersion).map((reading) => ({
    reading,
    direction: pinDirection(reading.pin, expectedVersion),
  }));
}

/**
 * The ONE hold line a refresh prints when it refuses to rewrite an owned pin.
 * Phrased neutrally ("a pin is never lowered") because both `flair upgrade`'s
 * refresh and `flair doctor --fix` print it — no per-caller copy. An
 * unreadable pin names the reason it is held (flair#1778): a pin we cannot
 * compare is never lowered either.
 */
function heldPinMessage(id: string, pin: string, runningCli: string): string {
  if (comparePinVersions(pin, runningCli) === null) {
    return `${id}: keeping pinned ${pin} (the pin is not a version I can compare to running CLI ${runningCli} — a pin is never lowered)`;
  }
  return `${id}: keeping pinned ${pin} (running CLI ${runningCli} is older — a pin is never lowered)`;
}

/**
 * The ONE SessionStart-hook re-pin guard (flair#1778 D4), shared by
 * `flair upgrade`'s pin refresh and `flair doctor --fix`.
 *
 * Rebuilds an already-wired hook to the running CLI's version, but never
 * LOWERS an owned pin: when the running CLI is older than the pin present, OR
 * when the pin cannot be compared (not strict semver), it HOLDS — `action:
 * "hold"`, with a line naming both versions — instead of rewriting. The guard
 * FAILS CLOSED on an unreadable pin (`pinWriteWouldLowerOrIsUnknown`). There is
 * no second copy of this decision:
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
  if (pinWriteWouldLowerOrIsUnknown(existing, wouldWrite)) {
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
 * PIN-ONLY (flair#1834 A1): the JSON MCP writer changes only the
 * `@tpsdev-ai/flair-mcp` element of an entry's `args`, so a refresh needs NO
 * agent id — it preserves each entry's OWN identity. SessionStart hooks were
 * always identity-free here (`repinSessionStartHook` reads the agent from the
 * existing command). Nothing here invents a host-wide identity.
 *
 * The MCP branch VISITS a target only when its entry exists or its directory
 * exists (round 2): an absent parent (a Claude-Code-only home has no ~/.gemini
 * etc.) is a quiet skip, while an EACCES / ELOOP / ENOTDIR parent still falls
 * through so the refusal is reported.
 *
 * NEVER adds a hook or wires a new client.
 */
export function refreshOwnedPins(opts: RefreshOwnedPinsOptions): OwnedPinRefreshResult[] {
  const { homeDir } = opts;
  const targets = listOwnedPinTargets(homeDir);
  const results: OwnedPinRefreshResult[] = [];
  // flair#1779: an optional restriction to specific targets (kind + id).
  // ONLY restricted targets are visited.
  const restricted = opts.targets
    ? new Map(opts.targets.map((t) => [`${t.kind}:${t.id}`, t]))
    : null;

  return withHome(homeDir, () => {
    for (const target of targets) {
      const override = restricted ? restricted.get(`${target.kind}:${target.id}`) : undefined;
      if (restricted && !override) continue;
      if (target.kind === "session-start-hook") {
        // flair#1778 D4: never re-pin a hook DOWN. The guard lives in ONE place
        // (repinSessionStartHookGuarded) so `flair doctor --fix` shares it
        // rather than growing a second implementation.
        results.push(repinSessionStartHookGuarded(homeDir, target.id as Harness, target));
        continue;
      }

      // flair#1834 A1: a JSON MCP refresh is PIN-ONLY — it changes only the
      // `@tpsdev-ai/flair-mcp` element of the entry's args, preserving the
      // entry's OWN identity (FLAIR_AGENT_ID, FLAIR_URL) and every other key.
      // There is no host-wide identity to guess and no full re-wire here.
      // flair#1834 A2: Codex (TOML) has its own pin-only writer
      // (repinCodexPin), so its refresh no longer skips — it flows through the
      // SAME visit gate and the SAME writer-result seam below.
      // flair#1834 A1 round 2 (Kern BLOCKING): a VISIT gate. When the entry is
      // not visible AND its directory is absent, there is nothing to visit —
      // the primitive cannot resolve the parent and refuses, which the writer
      // reported as a failure (2-3 such lines on every upgrade for a
      // Claude-Code-only machine). Skip quietly. EACCES / ELOOP / ENOTDIR (the
      // directory is present but broken) is NOT absence: fall through so the
      // refusal stays LOUD.
      if (!readOwnedPin(target, homeDir).entryExists) {
        // flair#1834 A1 round 3: lstat does NOT follow a symlink, so a DANGLING
        // symlink directory is caught here — statSync would follow it and report
        // ENOENT, quiet-skipping a broken configuration. A genuinely absent
        // parent (ENOENT on the link itself) stays a quiet skip; EACCES / ELOOP
        // / ENOTDIR stay loud (fall through to the writer, below).
        const parent = dirname(target.path);
        let parentAbsent = false;
        let dangling = false;
        try {
          const st = lstatSync(parent);
          if (st.isSymbolicLink()) {
            try { statSync(parent); } catch (err) {
              if ((err as NodeJS.ErrnoException)?.code === "ENOENT") dangling = true;
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") parentAbsent = true;
        }
        if (dangling) {
          results.push({
            target,
            action: "skip",
            ok: false,
            message: `${target.id}: ${parent} is a dangling symlink (its target does not exist) — refusing to treat a broken configuration as unwired; fix the link`,
          });
          continue;
        }
        if (parentAbsent) {
          results.push({ target, action: "skip", ok: true, message: `${target.id}: not wired — skip` });
          continue;
        }
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
      // Both writers fail closed on an ambiguous shape or a pin the never-lower
      // guard cannot prove safe; neither wires an absent entry (a clean `skip`).
      const repin = target.id === "codex"
        ? repinCodexPin(target.path, client.label, opts.testHooks)
        : repinJsonMcpPin(target.path, client.label, opts.testHooks);
      switch (repin.kind) {
        case "repinned":
          results.push({
            target,
            action: "update",
            ok: true,
            message:
              `re-pinned ${client.label} (${repin.oldPin} -> ${repin.newPin})` +
              (repin.noIdentity ? " — no identity configured" : ""),
          });
          break;
        case "noop":
          results.push({ target, action: "noop", ok: true, message: repin.line ?? `${client.label}: pin already current` });
          break;
        case "skip":
          results.push({ target, action: "skip", ok: true, message: repin.line ?? `${target.id}: not wired — skip` });
          break;
        case "hold":
          results.push({ target, action: "hold", ok: true, message: `HOLD ${client.label}: ${repin.line}` });
          break;
        case "failed":
          // Failed write stays skip+ok:false (fail-closed, like hook re-pin).
          // ownedPinRefreshShouldReport treats !ok as printable — do not recode
          // this as a quiet skip.
          results.push({ target, action: "skip", ok: false, message: `${client.label}: ${repin.line}` });
          break;
      }
    }
    return results;
  });
}
