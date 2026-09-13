/**
 * keys.ts — `flair keys` command group + key-prune decision logic (flair#1629 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. `KeysPruneEntry`,
 * `KeysPruneResult`, `classifyKeysDir`, and `applyKeyPrune` deliberately stay
 * module-level and exported here (they are unit-tested directly — see
 * test/unit/keys-prune.test.ts — so src/cli.ts re-exports them). The commander
 * registration (`keys prune`) and its action handler live in register().
 *
 * SECURITY: this module only moves existing key-generation / path-resolution /
 * file-permission logic verbatim. It does not add or alter any crypto or
 * filesystem-permission behavior.
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import { existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as render from "../render.js";
import { loadEd25519PrivateKeyFromFile } from "../mcp-client-assertion.js";
import { defaultKeysDir } from "../lib/auth-resolve.js";
import {
  describeAgentGateFinding,
  classifyKeyFile,
  resolveCollisionSafeName,
  pruneDateStamp,
  PRUNED_DIR_NAME,
  type AgentGateState,
  type KeyPruneClass,
} from "../doctor-client.js";

export type KeysCli = {
  checkAgentRegistered: (
    baseUrl: string,
    agentId: string,
    keysDir: string,
  ) => Promise<{ state: AgentGateState; detail?: string }>;
  probeFlairReachable: (url: string, timeoutMs?: number) => Promise<boolean>;
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
};

let cli: KeysCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: KeysCli): void {
  cli = fns;
}

const checkAgentRegistered = (
  baseUrl: string,
  agentId: string,
  keysDir: string,
): Promise<{ state: AgentGateState; detail?: string }> => cli.checkAgentRegistered(baseUrl, agentId, keysDir);

const probeFlairReachable = (url: string, timeoutMs?: number): Promise<boolean> =>
  cli.probeFlairReachable(url, timeoutMs);

const resolveBaseUrl = (opts: { target?: string; url?: string; port?: string | number }): string =>
  cli.resolveBaseUrl(opts);

// ─── flair keys ────────────────────────────────────────────────────────────────
// flair#734 — recoverable cleanup of stale/unregistered/invalid key files in
// the key dir. Follow-up to #731's doctor agent-iteration, which made this
// state visible (every stale key renders as a "not registered" gate finding,
// src/doctor-client.ts describeAgentGateFinding) but shipped no way to act on
// it — every doctor run just re-reported the same noise, and the dir kept
// accreting e2e-test leftovers. `agent remove <id>` already handles the
// REGISTERED case (agent + key together); this fills the gap for keys with no
// agent behind them at all: test leftovers, renamed-agent leftovers, and
// files that were never valid Ed25519 seeds to begin with.
//
// classifyKeysDir/applyKeyPrune are exported (not inlined in the action) so
// they're directly unit-testable with a mocked fetch + a temp keys dir, same
// pattern as checkAgentRegistered/probeFlairReachable above (see
// test/unit/doctor-client-network.test.ts) — no subprocess, no real ~/.flair.

export interface KeysPruneEntry {
  name: string;
  class: KeyPruneClass;
  reason: string;
  agentId?: string;
}

export interface KeysPruneResult {
  /** True when the configured instance could not be confirmed reachable —
   *  the WHOLE run stops the moment this happens, before classifying
   *  anything else (never classify offline). `entries` is always empty here. */
  aborted: boolean;
  abortReason?: string;
  entries: KeysPruneEntry[];
}

/** Best-effort seed-validity check for a `.key` file: does it parse via any
 *  of the formats loadEd25519PrivateKeyFromFile (src/mcp-client-assertion.ts
 *  — the same loader `flair mcp token` uses) accepts? Never throws — used
 *  only to decide "unidentified" vs. "worth a registration check", not to
 *  actually sign anything. An unparseable file is not junk: the keys dir is
 *  also where FileKeyStore writes AES-256-GCM blobs (flair#1026). */
function isValidPrivateKeySeedFile(keyPath: string): boolean {
  try {
    loadEd25519PrivateKeyFromFile(keyPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify every entry in `keysDir` for `flair keys prune`. Pure READ —
 * never writes or moves anything; see applyKeyPrune below for the actual
 * move. Directories (including keysDir's own `.pruned` archive, PRUNED_DIR_NAME)
 * and files not ending in `.key` are "ignored" without any network call.
 * `.key` files with an unparseable seed are "unidentified" without a network
 * call either — reported, never pruned (flair#1026). Only a `.key` file that
 * DOES parse triggers a signed `GET /Agent/:id` against `baseUrl`
 * (checkAgentRegistered above, the exact same check doctor's registration
 * gate uses).
 *
 * If that check EVER reports "unreachable" — the instance couldn't be
 * confirmed up for that key — the WHOLE run aborts immediately
 * (`aborted: true`, `entries: []`, short-circuiting the loop): never
 * classify anything, prunable or not, while registration state can't be
 * verified. A missing keysDir is treated as "nothing to classify" (fresh
 * install), not an error — matches `flair doctor`'s own "Keys directory
 * missing" being a separate, non-fatal finding.
 */
export async function classifyKeysDir(keysDir: string, baseUrl: string): Promise<KeysPruneResult> {
  if (!existsSync(keysDir)) return { aborted: false, entries: [] };

  const dirents = readdirSync(keysDir, { withFileTypes: true });
  const entries: KeysPruneEntry[] = [];
  const candidates: Array<{ name: string; agentId: string }> = [];

  for (const d of dirents) {
    if (d.isDirectory()) {
      entries.push({
        name: d.name,
        class: "ignored",
        reason: d.name === PRUNED_DIR_NAME ? "prune archive directory" : "directory (not a key file)",
      });
      continue;
    }
    if (!d.name.endsWith(".key")) {
      entries.push({ name: d.name, class: "ignored", reason: "not a .key file" });
      continue;
    }
    candidates.push({ name: d.name, agentId: d.name.slice(0, -".key".length) });
  }

  for (const c of candidates) {
    const keyPath = join(keysDir, c.name);
    if (!isValidPrivateKeySeedFile(keyPath)) {
      const decision = classifyKeyFile(c.agentId, false, null, baseUrl);
      entries.push({ name: c.name, class: decision.class, reason: decision.reason, agentId: c.agentId });
      continue;
    }

    const reg = await checkAgentRegistered(baseUrl, c.agentId, keysDir);
    if (reg.state === "unreachable") {
      return {
        aborted: true,
        abortReason:
          `could not reach ${baseUrl} to verify agent '${c.agentId}' is registered` +
          `${reg.detail ? ` (${reg.detail})` : ""} — aborting; nothing was classified or moved. ` +
          `Pass --instance <url> to target a different instance.`,
        entries: [],
      };
    }
    // flair#1023 added "key-unreadable". It cannot occur here — this key's
    // seed already parsed via isValidPrivateKeySeedFile above — but is
    // handled explicitly rather than folded into the else: a key that will
    // not load is "unidentified", not prunable "invalid" (flair#1026).
    const decision = reg.state === "key-unreadable"
      ? classifyKeyFile(c.agentId, false, null, baseUrl)
      : classifyKeyFile(c.agentId, true, { state: reg.state, detail: reg.detail }, baseUrl);
    entries.push({ name: c.name, class: decision.class, reason: decision.reason, agentId: c.agentId });
  }

  return { aborted: false, entries };
}

/**
 * Move every "stale" or "invalid" entry from `keysDir` into
 * `<keysDir>/.pruned/<dateStamp>/`, creating the archive dir as needed —
 * MOVE, never delete, so a bad classification is always recoverable. Only
 * ever called with entries classifyKeysDir already decided are prunable; a
 * "keep" or "ignored" entry passed in here is simply skipped (defense in
 * depth — a registered agent's key must never move, even if a caller bug
 * fed it in). Collisions (same filename already archived from an earlier
 * prune run today) get a numeric suffix (resolveCollisionSafeName) rather
 * than silently overwriting the earlier archive.
 */
export function applyKeyPrune(
  keysDir: string,
  entries: KeysPruneEntry[],
  dateStamp: string,
): Array<{ name: string; movedTo: string }> {
  const prunable = entries.filter((e) => e.class === "stale" || e.class === "invalid");
  if (prunable.length === 0) return [];

  const destDir = join(keysDir, PRUNED_DIR_NAME, dateStamp);
  mkdirSync(destDir, { recursive: true });
  const existing = new Set(readdirSync(destDir));

  const moved: Array<{ name: string; movedTo: string }> = [];
  for (const e of prunable) {
    const destName = resolveCollisionSafeName(existing, e.name);
    existing.add(destName);
    const from = join(keysDir, e.name);
    const to = join(destDir, destName);
    renameSync(from, to);
    moved.push({ name: e.name, movedTo: to });
  }
  return moved;
}

/** Register the `flair keys` command group (flair#1629). */
export function register(program: Command): void {
  const keys = program.command("keys").description("Manage Ed25519 key files in the key directory");

  keys
    .command("prune")
    .description("Move stale/unregistered/invalid keys to <keysDir>/.pruned/<date>/ — dry-run by default")
    .option("--apply", "Actually move prunable keys (default: dry-run, prints what would move and why)")
    .option("--keys-dir <dir>", "Directory to scan for key files (else FLAIR_KEY_DIR, ~/.flair/keys)")
    .option("--instance <url>", "Flair instance to check registration against (else FLAIR_TARGET/FLAIR_URL/config)")
    .option("--port <port>", "Harper HTTP port (used when --instance/FLAIR_URL/FLAIR_TARGET are not set)")
    .action(async (opts) => {
      const keysDir: string = opts.keysDir ?? process.env.FLAIR_KEY_DIR ?? defaultKeysDir();
      const baseUrl = resolveBaseUrl({ target: opts.instance, port: opts.port });
      const apply = !!opts.apply;

      console.log(`\n${render.wrap(render.c.bold, "🔑 Flair Keys Prune")}${apply ? "" : render.wrap(render.c.dim, " (dry run)")}\n`);
      console.log(`  Keys directory: ${render.wrap(render.c.dim, keysDir)}`);
      console.log(`  Instance:       ${render.wrap(render.c.dim, baseUrl)}\n`);

      const result = await classifyKeysDir(keysDir, baseUrl);
      if (result.aborted) {
        console.error(`  ${render.icons.error} ${result.abortReason}`);
        console.log("");
        process.exit(1);
      }

      const stale = result.entries.filter((e) => e.class === "stale");
      const invalid = result.entries.filter((e) => e.class === "invalid");
      const unidentified = result.entries.filter((e) => e.class === "unidentified");
      const kept = result.entries.filter((e) => e.class === "keep");
      const ignored = result.entries.filter((e) => e.class === "ignored");
      const prunable = [...stale, ...invalid];

      if (stale.length + invalid.length + unidentified.length + kept.length === 0) {
        console.log(`  ${render.icons.ok} No key files found in ${render.wrap(render.c.dim, keysDir)} — nothing to prune.`);
        console.log("");
        return;
      }

      for (const e of prunable) {
        const icon = e.class === "invalid" ? render.icons.error : render.icons.warn;
        console.log(`  ${icon} ${render.wrap(render.c.bold, e.name)} — ${e.class}: ${e.reason}`);
      }
      for (const e of unidentified) {
        console.log(`  ${render.icons.warn} ${render.wrap(render.c.bold, e.name)} — unidentified: ${e.reason}`);
      }
      for (const e of kept) {
        console.log(`  ${render.icons.ok} ${e.name} — registered, keeping`);
      }

      if (!apply) {
        console.log("");
        console.log(
          `  ${render.wrap(render.c.dim, `${prunable.length} prunable (${stale.length} stale, ${invalid.length} invalid), ${kept.length} kept, ${unidentified.length} unidentified (left in place), ${ignored.length} ignored`)}`,
        );
        if (prunable.length > 0) {
          console.log(`  ${render.wrap(render.c.dim, "Run with --apply to move prunable keys to")} ${join(keysDir, PRUNED_DIR_NAME, pruneDateStamp())}`);
        }
        console.log("");
        return;
      }

      const moved = applyKeyPrune(keysDir, result.entries, pruneDateStamp());
      console.log("");
      for (const m of moved) {
        console.log(`  ${render.icons.ok} moved ${m.name} -> ${m.movedTo}`);
      }
      console.log(`\n  ${render.wrap(render.c.bold, String(moved.length))} moved, ${kept.length} kept, ${unidentified.length} unidentified (left in place), ${ignored.length} ignored\n`);
    });
}
