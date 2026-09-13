/**
 * doctor-federation-driver.ts — gate doctor's federation-driver check (flair#1514).
 *
 * `describeScheduledDriverFinding` treats unit-files-on-disk + not-loaded as
 * ✗ INSTALLED BUT NOT LOADED. On a standalone install that never paired a
 * hub there is nothing for the driver to run, so that ✗ is a false alarm
 * (and a red one — operators tightening a fleet read it as broken sync).
 *
 * The gate:
 *   - zero peers configured → N/A / informational, never ✗, never an issue
 *   - peers ARE configured + driver present → the scheduled-driver verdict
 *   - peers ARE configured + driver missing/broken → still ✗
 *
 * "Peers configured" is an OR of the same places the issue asked us to look:
 * live /FederationPeers, component config.yaml (resolved from the component
 * dir — see doctor-config-path.ts), FLAIR_FEDERATION_* hub/peer env (not
 * the require-* policy flags), and node-scoped federation keys.
 *
 * Policy flags (`FLAIR_FEDERATION_REQUIRE_RECORD_*`) do not mean peers exist.
 * Treating them as configured would re-fail a standalone install that only
 * set a harden-the-edge default.
 */

import { existsSync, readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import {
  describeScheduledDriverFinding,
  type ScheduledDriverFacts,
  type ScheduledDriverFinding,
} from "./scheduler-platform.js";

/** Known policy-only FLAIR_FEDERATION_* keys — not a peer/hub declaration. */
export const FEDERATION_POLICY_ENV_KEYS = [
  "FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES",
  "FLAIR_FEDERATION_REQUIRE_RECORD_PRINCIPAL",
] as const;

const POLICY_ENV = new Set<string>(FEDERATION_POLICY_ENV_KEYS);

const ENV_ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export interface FederationConfiguredInput {
  /**
   * Non-revoked peers from a successful GET /FederationPeers.
   * null/undefined = the live read was not taken or failed (unverifiable).
   */
  livePeerCount?: number | null;
  /** Parsed component/user config.yaml (already resolved from the component dir). */
  configDoc?: unknown;
  /** Merged process + component-.env FLAIR_FEDERATION_* values. */
  env?: Record<string, string | undefined>;
  /** Node-scoped federation key ids under ~/.flair/keys (flair#1193). */
  nodeKeyIds?: readonly string[];
}

/**
 * True when any signal says this install has federation peers (or a hub)
 * to sync with. Any positive signal wins — missing the component-dir
 * config is how the check would go silent on a real peered install.
 */
export function federationPeersConfigured(input: FederationConfiguredInput): boolean {
  if (typeof input.livePeerCount === "number" && input.livePeerCount > 0) return true;
  if (input.nodeKeyIds && input.nodeKeyIds.length > 0) return true;
  if (envDeclaresFederationPeers(input.env ?? {})) return true;
  if (configDeclaresFederationPeers(input.configDoc)) return true;
  return false;
}

export function envDeclaresFederationPeers(env: Record<string, string | undefined>): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FLAIR_FEDERATION_")) continue;
    if (POLICY_ENV.has(key)) continue;
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

function looksLikePeerEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const o = entry as Record<string, unknown>;
  const keys = ["endpoint", "url", "hub", "target", "publicKey", "role", "id"];
  return keys.some((k) => typeof o[k] === "string" && String(o[k]).trim().length > 0);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function peersArrayDeclares(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.some(looksLikePeerEntry);
}

/**
 * Conservative read of config.yaml: only explicit federation hub/peer
 * declarations count. A Harper component config with no `federation`
 * block (the shipped default) is not configured.
 */
export function configDeclaresFederationPeers(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const root = doc as Record<string, unknown>;
  const fed = root.federation;
  if (fed && typeof fed === "object") {
    const f = fed as Record<string, unknown>;
    if (peersArrayDeclares(f.peers)) return true;
    if (nonEmptyString(f.hub) || nonEmptyString(f.endpoint) || nonEmptyString(f.target) || nonEmptyString(f.url)) {
      return true;
    }
  }
  if (peersArrayDeclares(root.peers)) return true;
  return false;
}

/** Load + parse a YAML file; unreadable/unparseable → null (not "no peers"). */
export function loadYamlDoc(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return parseYaml(readFileSync(path, "utf-8")) ?? null;
  } catch {
    return null;
  }
}

/** KEY=value assignments from a .env body. Values are not interpreted beyond trim/quotes. */
export function parseEnvAssignments(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_ASSIGNMENT_RE.exec(line);
    if (!m) continue;
    let v = line.slice(line.indexOf("=") + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Merge process.env FLAIR_FEDERATION_* with assignments from component
 * `.env` files. Process env wins (same as Harper loadEnv: already-set
 * names are not overwritten).
 */
export function collectFederationEnv(opts: {
  processEnv?: Record<string, string | undefined>;
  envFilePaths?: readonly string[];
}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const processEnv = opts.processEnv ?? process.env;
  for (const [key, value] of Object.entries(processEnv)) {
    if (key.startsWith("FLAIR_FEDERATION_")) out[key] = value;
  }
  for (const p of opts.envFilePaths ?? []) {
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseEnvAssignments(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith("FLAIR_FEDERATION_")) continue;
      if (out[key] === undefined) out[key] = value;
    }
  }
  return out;
}

export interface FederationDriverFindingInput {
  peersConfigured: boolean;
  driver: ScheduledDriverFacts;
}

/**
 * Doctor verdict for the federation sync driver (flair#1514).
 *
 * Not-configured is N/A: informational marker, never the fail marker,
 * never an issue. Configured + missing/broken still ✗ — the check is
 * gated, not silenced.
 */
export function describeFederationDriverFinding(
  input: FederationDriverFindingInput,
): ScheduledDriverFinding {
  if (!input.peersConfigured) {
    const idle = input.driver.installed
      ? "not configured (driver installed, idle)"
      : "not configured";
    return {
      state: "not-enabled",
      icon: "info",
      isIssue: false,
      message: `Federation: ${idle}`,
      detail: input.driver.installed
        ? ["No peers configured — the sync driver has nothing to run. This is the healthy default."]
        : ["No peers configured. Pair a hub (`flair federation pair`) before enabling the sync driver."],
    };
  }
  if (!input.driver.installed) {
    return {
      state: "degraded",
      icon: "error",
      isIssue: true,
      message: `${input.driver.label}: not installed — nothing will run federation sync`,
      detail: [
        "Peers are configured, but the sync driver is not installed, so nothing will push to them.",
        `Fix: ${input.driver.enableCommand}   # then check: ${input.driver.statusCommand}`,
      ],
    };
  }
  return describeScheduledDriverFinding(input.driver);
}
