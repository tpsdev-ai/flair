// ─── Client Detection & Wiring ──────────────────────────────────────────────────────
//
// Detects locally installed clients and wires them to Flair. Most are MCP
// clients (kind: "mcp" — wired via an mcpServers block/TOML table running
// @tpsdev-ai/flair-mcp); pi is a native-extension host (kind:
// "native-extension" — wired via pi's own settings.json `packages` key,
// flair#1342). Each client has:
//   - detection: `bin` on PATH, optionally widened by a declared detect() override
//   - wire(env): { ok: boolean; message: string }
//
// Wiring contract (FIX 4 — onboarding dogfood round 1):
//   "wired" MUST mean a config file was actually written. A wire function returns
//   { ok: true } ONLY when it merged the Flair MCP server into the client's real
//   config file. If it cannot (unknown path, write error), it returns
//   { ok: false } with the correct per-OS snippet to paste — never a vague
//   "manual wiring required" while elsewhere the run claims the client is wired.
//   All paths are resolved cross-platform (Linux included) via standard
//   per-client locations under $HOME / $XDG_CONFIG_HOME.

export type ClientId = "claude-code" | "codex" | "gemini" | "cursor" | "antigravity" | "pi";

/**
 * The env block every wire function writes into a client's MCP server config.
 * `FLAIR_CLIENT` (flair#718 authorship-provenance) is OPTIONAL and additive —
 * when the caller sets it (flair init's per-client wiring sets it to the
 * client's own id, e.g. "codex"), the written env block records WHICH CLIENT
 * this config wires, so writes forwarded through it stamp
 * `provenance.claimed.client` server-side (resources/provenance.ts). Absent
 * entirely on an un-set call = omitted from the written config, byte-for-byte
 * the same output as before this field existed (flair doctor's --fix
 * re-wiring path deliberately does not set it — out of scope for this slice).
 */
export type WireEnv = { FLAIR_AGENT_ID: string; FLAIR_URL: string; FLAIR_CLIENT?: string };

export interface Client {
  id: ClientId;
  label: string;
  /** The executable that has to be on PATH for this client to be usable. */
  bin: string;
  /**
   * How this client consumes Flair (flair#1342):
   *   "mcp"              — runs @tpsdev-ai/flair-mcp via an MCP server config
   *                        (mcpServers block / TOML table). readClientMcpBlock
   *                        and the MCP-pin machinery apply.
   *   "native-extension" — loads a Flair-shipped extension through the client's
   *                        own plugin mechanism (pi + @tpsdev-ai/pi-flair — pi
   *                        has no MCP client support). The MCP-pin machinery
   *                        does NOT apply; wiring/checking is client-specific.
   * Callers that iterate ALL_CLIENTS for MCP-shaped work MUST filter on this
   * rather than assuming every registry entry has an mcpServers block.
   */
  kind: "mcp" | "native-extension";
  detected: boolean;
  /**
   * Optional detection override. Default detection is `bin` on PATH (one rule,
   * see detectClients); a client whose presence is ALSO evidenced by a config
   * file (pi: ~/.pi/agent/settings.json survives PATH quirks like a version
   * manager or launchd context) declares that here. Must stay a pure
   * filesystem check — detection never spawns a subprocess (flair#946).
   */
  detect?: () => boolean;
  wire: (env: WireEnv) => { ok: boolean; message: string };
}

// ---- Detection helpers ----------------------------------------------------------

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { flairCliVersion, isResolvedVersion, mcpServerSpec } from "../lib/mcp-spec.js";

/**
 * Resolve the user's home dir. Prefer the live HOME/USERPROFILE env over
 * os.homedir(), which caches the value at process start and so ignores a
 * runtime HOME override — same convention as src/cli.ts ("so tests can
 * override"). Production behavior is unchanged (HOME is set on every OS).
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Check if a command exists in PATH (cross-platform alternative to `which`).
 * Does not spawn a child process — pure filesystem check.
 */
function binInPath(name: string): boolean {
  try {
    const sep = process.platform === "win32" ? ";" : ":";
    const dirs = (process.env.PATH || "").split(sep);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [];
    for (const dir of dirs) {
      if (!dir) continue;
      const base = `${dir}/${name}`;
      try { accessSync(base, constants.X_OK); return true; } catch { /* not here */ }
      for (const ext of exts) {
        try { accessSync(`${base}${ext}`, constants.X_OK); return true; } catch { /* not here */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * A client is INSTALLED when its executable is on PATH. One rule for all four,
 * evaluated with filesystem calls only — detection never starts a subprocess.
 *
 * Claude Code, Codex and Gemini used to fall back to `npm list -g <pkg>` when
 * the binary was absent. That fallback was removed (flair#906 follow-up); it
 * was wrong in three separate directions and bought nothing:
 *
 *   1. UNBOUNDED AND SLOW ON AN INTERACTIVE PATH. `npm list -g <pkg>` walks the
 *      whole global tree, measured at ~0.8 s per call on a warm developer
 *      machine, with no `timeout` set. `flair init` calls detectClients(), so a
 *      user with none of these clients paid up to three of those walks — seconds
 *      of silent stall on first run — and on a loaded CI runner the same three
 *      calls blew past a 5 s test timeout.
 *
 *   2. FALSE POSITIVES. `npm list -g <pkg>` exits 0 when the package appears
 *      ANYWHERE in the global tree, including as a transitive dependency of an
 *      unrelated global package. Gemini was probed with `@google/generative-ai`
 *      — a library, not the CLI — so any globally installed tool that depended
 *      on it made Flair report Gemini "detected" and write ~/.gemini/settings.json
 *      for a CLI that was not on the machine.
 *
 *   3. FALSE NEGATIVES. It assumes npm's default global prefix, so it reports
 *      "not installed" for mise / fnm / nvm / volta users whose prefix lives
 *      elsewhere — the same defect already fixed for `flair upgrade`'s presence
 *      probes (see "Upgrade presence probes" in src/cli.ts).
 *
 * Nothing is lost by dropping it: an `npm install -g` links the package's bin
 * into the prefix's bin directory, which is on PATH by construction (it is where
 * `npm` itself is found from). A client whose binary is NOT on PATH is a client
 * the user cannot launch, and wiring an MCP config for it is at best a no-op.
 * `flair init --client <name>` still wires a client explicitly, bypassing
 * detection entirely, so an exotic install is never locked out.
 */
function detectBin(bin: string): boolean {
  try {
    return binInPath(bin);
  } catch (_e: unknown) {
    return false;
  }
}

// ---- Shared config shapes -------------------------------------------------------

/**
 * The standard MCP stdio server entry every client (except Codex TOML) uses.
 *
 * The spec comes from mcpServerSpec() and is therefore PINNED — this used to
 * hardcode the bare `@tpsdev-ai/flair-mcp`, so Gemini, Cursor and the Claude
 * Code array fallback were all wired unpinned while only the inline Claude
 * Code path in cli.ts got the pin it was documented to get (flair#907).
 */
function flairMcpEntry(env: WireEnv) {
  return {
    command: "npx",
    args: ["-y", mcpServerSpec()],
    env: {
      FLAIR_AGENT_ID: env.FLAIR_AGENT_ID,
      FLAIR_URL: env.FLAIR_URL,
      // flair#718 — only present when the caller set it; absent = omitted,
      // not written as FLAIR_CLIENT: undefined.
      ...(env.FLAIR_CLIENT ? { FLAIR_CLIENT: env.FLAIR_CLIENT } : {}),
    },
  };
}

/** Pretty-printed JSON `mcpServers.flair` snippet for copy-paste fallbacks. */
function jsonSnippet(env: WireEnv): string {
  return JSON.stringify({ mcpServers: { flair: flairMcpEntry(env) } }, null, 2);
}

/** TOML `[mcp_servers.flair]` snippet (Codex format). Exported for tests
 * (flair#727 — asserts the rendered template carries a full scheme+port URL).
 * Pinned via mcpServerSpec() — see flairMcpEntry above for why (flair#907). */
export function tomlSnippet(env: WireEnv): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${mcpServerSpec()}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${env.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${env.FLAIR_URL}"`,
    // flair#718 — only present when the caller set it (same rule as flairMcpEntry above).
    ...(env.FLAIR_CLIENT ? [`FLAIR_CLIENT = "${env.FLAIR_CLIENT}"`] : []),
  ].join("\n");
}

/**
 * True when `raw` TOML content already has a `[mcp_servers.flair]` header —
 * the same detection scanCodexFlairBlock (src/doctor-client.ts) uses to
 * decide whether the block is present. Pure string scan; no TOML parser
 * (see the comment on _wireCodex below for why).
 */
export function codexConfigHasFlairSection(raw: string): boolean {
  return /^\[mcp_servers\.flair\]\s*$/m.test(raw);
}

/**
 * Pure merge: append the Flair TOML snippet to existing raw config.toml
 * content. Callers MUST first confirm codexConfigHasFlairSection(raw) is
 * false — appending a second `[mcp_servers.flair]` table would shadow/
 * duplicate the first (TOML doesn't merge repeated table headers), so this
 * function does not re-check; it just appends safely with a newline
 * separator (mirrors fixClaudeMdBootstrap's separator logic in
 * src/doctor-client.ts — never runs the new block into the prior line).
 */
export function appendCodexFlairBlock(raw: string, env: WireEnv): string {
  const separator = raw.length === 0 ? "" : raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
  return raw + separator + tomlSnippet(env) + "\n";
}

/**
 * flair#1135: does the existing `[mcp_servers.flair]` TOML section carry the
 * CURRENT pinned mcpServerSpec()? Pure string scan — no TOML parser needed
 * (same rationale as codexConfigHasFlairSection).
 */
function codexFlairSectionHasCurrentPin(raw: string): boolean {
  const idx = raw.indexOf("[mcp_servers.flair]");
  if (idx === -1) return false;
  const after = raw.slice(idx);
  // Find the end of the section: the next top-level [header] that is NOT a
  // sub-table of mcp_servers.flair (e.g. [mcp_servers.flair.env] is part of
  // the same logical section and must not terminate the scan).
  const nextHeader = after.slice("[mcp_servers.flair]".length).search(/\n\[(?!mcp_servers\.flair\.)/);
  const section = nextHeader === -1 ? after : after.slice(0, "[mcp_servers.flair]".length + nextHeader);
  return section.includes(mcpServerSpec());
}

/**
 * flair#1135: replace the existing `[mcp_servers.flair]` TOML section with a
 * fresh one carrying the current pin. Preserves everything else in the file.
 */
function replaceCodexFlairBlock(raw: string, env: WireEnv): string {
  const idx = raw.indexOf("[mcp_servers.flair]");
  if (idx === -1) return appendCodexFlairBlock(raw, env);
  const before = raw.slice(0, idx);
  const after = raw.slice(idx);
  const nextHeader = after.slice("[mcp_servers.flair]".length).search(/\n\[(?!mcp_servers\.flair\.)/);
  const rest = nextHeader === -1 ? "" : after.slice("[mcp_servers.flair]".length + nextHeader);
  const newBlock = tomlSnippet(env) + "\n";
  // Preserve the separator between the new block and whatever follows.
  const sep = rest.length === 0 ? "" : rest.startsWith("\n") ? "" : "\n";
  return before + newBlock + sep + rest;
}

/**
 * Merge the Flair MCP server into a JSON config file with an `mcpServers` map.
 * Creates the file (and parent dir) if absent; preserves existing servers and
 * any other top-level keys. Returns ok:true only when the file was written.
 */
function wireJsonMcp(
  configPath: string,
  label: string,
  env: WireEnv,
  // The parenthetical appended to a successful wire/refresh message. Defaults to
  // the confident "restart <label> to pick it up". A client whose end-to-end
  // pickup Flair has NOT verified (Antigravity — flair#1209) passes an honest
  // note instead, so the message claims only what it did (wrote the config), not
  // that the client will read it.
  pickupNote?: string,
): { ok: boolean; message: string } {
  const home = resolveHome();
  const display = configPath.startsWith(home) ? "~" + configPath.slice(home.length) : configPath;
  const note = pickupNote ?? `restart ${label} to pick it up`;
  try {
    let config: any = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8").trim();
      if (raw) config = JSON.parse(raw);
    }
    config.mcpServers = config.mcpServers || {};
    const existing = config.mcpServers.flair;
    const currentSpec = mcpServerSpec();
    const existingArgs = existing?.args;
    const argsMatch = Array.isArray(existingArgs) && existingArgs.includes(currentSpec);
    const urlAgentMatch = existing && existing.env?.FLAIR_URL === env.FLAIR_URL && existing.env?.FLAIR_AGENT_ID === env.FLAIR_AGENT_ID;
    // flair#1135: the pin in `args` must match the current mcpServerSpec().
    // A matching pin stays a no-op (idempotent); only a stale pin triggers a re-write.
    if (urlAgentMatch && argsMatch) {
      return { ok: true, message: `${label}: already wired in ${display}` };
    }
    config.mcpServers.flair = flairMcpEntry(env);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const action = urlAgentMatch ? "refreshed pin in" : "wired";
    return { ok: true, message: `${label}: ${action} ${display} (${note})` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `${label}: manual wiring needed (could not write ${display}: ${reason}).\n` +
        `   Add this to ${display}:\n${indent(jsonSnippet(env))}`,
    };
  }
}

function indent(s: string): string {
  return s.split("\n").map((l) => `     ${l}`).join("\n");
}

// ---- Per-client config paths (cross-platform, Linux included) --------------------

/** Cursor: ~/.cursor/mcp.json on every OS. */
function cursorConfigPath(): string {
  return join(resolveHome(), ".cursor", "mcp.json");
}

/** Gemini CLI: ~/.gemini/settings.json on every OS. */
function geminiConfigPath(): string {
  return join(resolveHome(), ".gemini", "settings.json");
}

/** Codex CLI: ~/.codex/config.toml on every OS. */
function codexConfigPath(): string {
  return join(resolveHome(), ".codex", "config.toml");
}

// ---- pi (native extension — NOT an MCP client) ------------------------------------
//
// pi has no MCP client support (packages/pi-flair/README "Design Decision"), so
// Flair ships @tpsdev-ai/pi-flair as a NATIVE pi extension. Wiring pi therefore
// means editing pi's OWN settings, not writing an mcpServers block (flair#1342):
//
//   ~/.pi/agent/settings.json          (user scope; pi's getSettingsPath() —
//                                       agent dir overridable via the
//                                       PI_CODING_AGENT_DIR env var, honored here)
//   <project>/.pi/settings.json        (project scope)
//
// Two settings keys matter, and confusing them is the flair#1346 field failure:
//
//   "packages"    — package SOURCES (`npm:`, `git:`, local paths, or
//                   { source, ...filters } objects). pi parses these through
//                   parseSource() and AUTO-INSTALLS a missing/mismatched npm
//                   package at resource collection (package-manager.js
//                   resolvePackageSources), honoring an exact `@<version>` pin.
//                   This is where npm:@tpsdev-ai/pi-flair belongs.
//   "extensions"  — local FILE PATHS only. An `npm:` spec here is treated as a
//                   path, fails existsSync, and is dropped WITHOUT ERROR — the
//                   user believes they are wired and pi registers zero tools.
//                   (Verified against pi 0.84.2's package-manager.js: the
//                   extensions override list feeds resolvePathFromBase/
//                   collectFilesFromPaths, never parseSource.)
//
// pi-flair reads FLAIR_AGENT_ID / FLAIR_URL / FLAIR_KEY_PATH from the process
// environment of the pi that loads it — pi settings carry NO per-package env
// block, so wiring here cannot pin an agent identity the way the MCP clients'
// env blocks do. Wire messages say so instead of pretending.

/** The npm package pi loads as its Flair extension. */
export const PI_FLAIR_PACKAGE = "@tpsdev-ai/pi-flair";

/**
 * pi-flair's own DEFAULT_FLAIR_URL (packages/pi-flair/src/index.ts). Duplicated
 * as a value rather than imported — the CLI does not depend on the pi-flair
 * workspace package — by the same convention as doctor-client's
 * FLAIR_CLIENT_DEFAULT_URL; a unit test (pi-client.test.ts) asserts this
 * literal matches pi-flair's source so the two cannot drift silently.
 */
export const PI_FLAIR_DEFAULT_URL = "http://127.0.0.1:19926";

/**
 * The `packages` entry a wired pi gets. PINNED for the same reason as
 * mcpServerSpec (flair#907): pi re-resolves an unpinned npm source to latest
 * when (re)installing, and pi-flair ships in version lockstep with the CLI.
 * Falls back to the bare spec when the CLI cannot read its own version — the
 * same condition and caller-owed warning as mcpServerSpec.
 */
export function piFlairSpec(version: string = flairCliVersion()): string {
  return isResolvedVersion(version)
    ? `npm:${PI_FLAIR_PACKAGE}@${version}`
    : `npm:${PI_FLAIR_PACKAGE}`;
}

/** pi's agent config dir: $PI_CODING_AGENT_DIR, else ~/.pi/agent (pi config.js). */
function piAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(resolveHome(), ".pi", "agent");
}

/** pi user-scope settings: <agent dir>/settings.json. */
export function piSettingsPath(): string {
  return join(piAgentDir(), "settings.json");
}

/** A pi `packages` array entry is a source string or `{ source, ...filters }`. */
export function piPackageEntrySource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
    return (entry as { source: string }).source;
  }
  return null;
}

/** Does this source string name the pi-flair package as an npm source
 *  (bare `npm:@tpsdev-ai/pi-flair` or any `npm:@tpsdev-ai/pi-flair@<spec>`)? */
export function isPiFlairNpmSource(source: string): boolean {
  if (typeof source !== "string" || !source.startsWith("npm:")) return false;
  const spec = source.slice("npm:".length).trim();
  return spec === PI_FLAIR_PACKAGE || spec.startsWith(`${PI_FLAIR_PACKAGE}@`);
}

/** The version text of a pinned pi-flair npm source, or null when bare. */
export function extractPiFlairPin(source: string): string | null {
  if (!isPiFlairNpmSource(source)) return null;
  const spec = source.slice("npm:".length).trim();
  const version = spec.slice(`${PI_FLAIR_PACKAGE}@`.length);
  return spec.startsWith(`${PI_FLAIR_PACKAGE}@`) && version ? version : null;
}

/**
 * Does this `extensions` entry point at pi-flair BY PATH (the documented
 * pre-0.49 workaround: a local path to the installed dist/index.js)? A
 * substring heuristic on the package/directory name — the entry is user-
 * written free text, so this is deliberately loose in the direction of
 * REPORTING (doctor names the entry it matched); it never gates anything
 * destructive.
 */
export function isPiFlairExtensionPath(entry: string): boolean {
  if (typeof entry !== "string" || entry.startsWith("npm:") || entry.startsWith("git:")) return false;
  return entry.includes("pi-flair");
}

/** What one pi settings file says about pi-flair. Pure — callers do the fs. */
export interface PiSettingsScan {
  /** File content parsed as a JSON object (false: missing/malformed/non-object). */
  parsed: boolean;
  /** The pi-flair source found under `packages`, verbatim. */
  packagesSpec?: string;
  /** Version from a pinned packages entry; null when bare or absent. */
  pinnedVersion: string | null;
  /** pi-flair FILE-PATH entries under `extensions` (the pre-0.49 workaround). */
  extensionFilePaths: string[];
  /** pi-flair `npm:` specs under `extensions` — pi silently ignores these
   *  (flair#1346, the known field failure); doctor calls them out by name. */
  misconfiguredNpmUnderExtensions: string[];
}

export function scanPiSettings(raw: string | null): PiSettingsScan {
  const empty: PiSettingsScan = { parsed: false, pinnedVersion: null, extensionFilePaths: [], misconfiguredNpmUnderExtensions: [] };
  if (!raw || !raw.trim()) return empty;
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return empty;
  const cfg = config as { packages?: unknown; extensions?: unknown };

  let packagesSpec: string | undefined;
  let pinnedVersion: string | null = null;
  if (Array.isArray(cfg.packages)) {
    for (const entry of cfg.packages) {
      const source = piPackageEntrySource(entry);
      if (source && isPiFlairNpmSource(source)) {
        packagesSpec = source;
        pinnedVersion = extractPiFlairPin(source);
        break;
      }
    }
  }

  const extensionFilePaths: string[] = [];
  const misconfiguredNpmUnderExtensions: string[] = [];
  if (Array.isArray(cfg.extensions)) {
    for (const entry of cfg.extensions) {
      if (typeof entry !== "string") continue;
      if (isPiFlairNpmSource(entry)) misconfiguredNpmUnderExtensions.push(entry);
      else if (isPiFlairExtensionPath(entry)) extensionFilePaths.push(entry);
    }
  }

  return { parsed: true, packagesSpec, pinnedVersion, extensionFilePaths, misconfiguredNpmUnderExtensions };
}

/**
 * Resolve a pi `extensions` path entry the way pi's loader will: `~/` against
 * the home dir, a relative path against the settings file's own base dir, an
 * absolute path as-is. `baseDir` is the directory pi treats as the scope's
 * base (user scope: the agent dir).
 */
export function resolvePiExtensionPath(entry: string, homeDir: string, baseDir: string): string {
  if (entry.startsWith("~/") || entry === "~") return join(homeDir, entry.slice(1));
  if (entry.startsWith("/")) return entry;
  return join(baseDir, entry);
}

/** Pretty-printed minimal settings snippet for copy-paste fallbacks. */
function piJsonSnippet(): string {
  return JSON.stringify({ packages: [piFlairSpec()] }, null, 2);
}

/**
 * Wire pi by editing ~/.pi/agent/settings.json `packages` (flair#1342) — the
 * same merge/idempotence/preservation contract as wireJsonMcp: sibling keys
 * and entries survive byte-identical, a current entry is a no-op, a stale pin
 * is refreshed, and ok:true means the file was actually written (or already
 * correct). Two pi-specific rules on top:
 *
 *   • an `npm:` pi-flair spec under `extensions` is MOVED to `packages` — that
 *     misplacement is silently ignored by pi (flair#1346), so leaving it while
 *     adding a packages entry would preserve a decoy;
 *   • an existing FILE-PATH `extensions` entry that resolves to a real file is
 *     honored as already-wired (the documented pre-0.49 workaround) — the user
 *     may deliberately be running a local build, so it is reported, not
 *     rewritten.
 *
 * `env` is used for the launch-environment hint only: pi settings have no
 * per-package env block, so FLAIR_AGENT_ID/FLAIR_URL must be exported by
 * whatever shell launches pi — the message says so rather than implying the
 * wiring carried them.
 */
function _wirePi(env: WireEnv): { ok: boolean; message: string } {
  const path = piSettingsPath();
  const home = resolveHome();
  const display = path.startsWith(home) ? "~" + path.slice(home.length) : path;
  const spec = piFlairSpec();
  const envHint = `pi settings carry no env — export FLAIR_AGENT_ID=${env.FLAIR_AGENT_ID} in the shell that launches pi`;
  try {
    let config: any = {};
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8").trim();
      if (raw) config = JSON.parse(raw);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("settings.json is not a JSON object");
    }
    if (config.packages !== undefined && !Array.isArray(config.packages)) {
      throw new Error(`"packages" exists but is not an array — not rewriting it`);
    }
    if (config.extensions !== undefined && !Array.isArray(config.extensions)) {
      throw new Error(`"extensions" exists but is not an array — not rewriting it`);
    }

    // The #1346 trap: npm: pi-flair specs under `extensions`. Collect + drop.
    let movedFromExtensions = false;
    if (Array.isArray(config.extensions)) {
      const kept = config.extensions.filter(
        (e: unknown) => !(typeof e === "string" && isPiFlairNpmSource(e)),
      );
      movedFromExtensions = kept.length !== config.extensions.length;
      if (movedFromExtensions) config.extensions = kept;
    }

    // Existing packages entry?
    let entryIndex = -1;
    let entrySource: string | null = null;
    if (Array.isArray(config.packages)) {
      for (let i = 0; i < config.packages.length; i++) {
        const source = piPackageEntrySource(config.packages[i]);
        if (source && isPiFlairNpmSource(source)) {
          entryIndex = i;
          entrySource = source;
          break;
        }
      }
    }

    if (!movedFromExtensions && entrySource === spec) {
      return { ok: true, message: `pi: already wired in ${display} (${spec})` };
    }

    if (!movedFromExtensions && entryIndex === -1) {
      // No packages entry and nothing misplaced — honor a working file-path
      // extensions entry (pre-0.49 workaround) instead of double-wiring.
      const scan = scanPiSettings(JSON.stringify(config));
      const workingPath = scan.extensionFilePaths.find((p) =>
        existsSync(resolvePiExtensionPath(p, home, piAgentDir())),
      );
      if (workingPath) {
        return {
          ok: true,
          message:
            `pi: already wired via a file-path extension in ${display} (${workingPath}) — ` +
            `the pre-0.49 workaround; the canonical form is a "packages" entry: ${spec}`,
        };
      }
    }

    config.packages = Array.isArray(config.packages) ? config.packages : [];
    let action: string;
    if (entryIndex >= 0) {
      const entry = config.packages[entryIndex];
      if (typeof entry === "string") config.packages[entryIndex] = spec;
      else entry.source = spec; // object entry: refresh source, keep filters
      action = movedFromExtensions
        ? `moved ${PI_FLAIR_PACKAGE} out of "extensions" and refreshed the "packages" pin in`
        : "refreshed pin in";
    } else if (movedFromExtensions) {
      config.packages.push(spec);
      action = `moved ${PI_FLAIR_PACKAGE} from "extensions" to "packages" in`;
    } else {
      config.packages.push(spec);
      action = "wired";
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    const trapNote = movedFromExtensions
      ? ` — pi silently ignores npm: specs under "extensions" (flair#1346)`
      : "";
    return {
      ok: true,
      message: `pi: ${action} ${display} (${spec} — pi installs the package on next launch; ${envHint})${trapNote}`,
    };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `pi: manual wiring needed (could not update ${display}: ${reason}).\n` +
        `   Add this to ${display} (${envHint}):\n${indent(piJsonSnippet())}`,
    };
  }
}

/**
 * Antigravity CLI (`agy`) + Antigravity 2.0 IDE + SDK: they share ONE central
 * MCP config at ~/.gemini/config/mcp_config.json on every OS (flair#1209).
 *
 * This is a SIBLING of, and distinct from, Gemini CLI's ~/.gemini/settings.json
 * (geminiConfigPath above) — both tools live under ~/.gemini but read different
 * files, so wiring one never touches the other. Same standard `mcpServers`
 * stdio schema (command/args/env) the JSON clients above use.
 *
 * Path per Antigravity's own docs (antigravity.google/docs/mcp) and a Google
 * Developer Advocate write-up (atamel.dev "Where does Antigravity look for MCP
 * Servers?"). NOTE: the end-to-end wiring has NOT been verified against a real
 * `agy` install — see the PR body.
 */
function antigravityConfigPath(): string {
  return join(resolveHome(), ".gemini", "config", "mcp_config.json");
}

/**
 * Single dispatcher for "where does this client's MCP config live" — used by
 * `flair doctor`'s client-integration checks (flair#588) to read the config
 * without duplicating the per-client path logic that already lives here.
 * Additive only: does not change existing wire/detect behavior.
 */
export function clientConfigPath(id: ClientId): string {
  switch (id) {
    case "claude-code":
      return join(resolveHome(), ".claude.json");
    case "codex":
      return codexConfigPath();
    case "gemini":
      return geminiConfigPath();
    case "cursor":
      return cursorConfigPath();
    case "antigravity":
      return antigravityConfigPath();
    case "pi":
      // NOT an MCP config: pi's own settings.json, where the pi-flair
      // native-extension wiring lives (flair#1342). readClientMcpBlock over
      // this file correctly reports "no MCP block" — pi never has one.
      return piSettingsPath();
  }
}

// ---- Internal wiring functions --------------------------------------------------
//
// Claude Code wiring lives inline in src/cli.ts (it writes ~/.claude.json, the
// one client the CLI safely edits, cross-platform). _wireClaudeCode here is the
// fallback used when something calls the array form; it returns the snippet for
// ~/.claude.json so the message is unambiguous and correct on every OS.

function _wireClaudeCode(env: WireEnv): { ok: boolean; message: string } {
  // The real auto-wire is inline in cli.ts. If reached via the array, point at
  // the correct cross-platform path (~/.claude.json — same on macOS/Linux/Win)
  // and give the exact snippet. Never emit macOS-only paths here.
  return wireJsonMcp(join(resolveHome(), ".claude.json"), "Claude Code", env);
}

function _wireCodex(env: WireEnv): { ok: boolean; message: string } {
  // Codex uses TOML with a [mcp_servers.flair] table. We don't carry a TOML
  // parser, but appending a new top-level table at EOF is safe TOML when the
  // exact header isn't already present (flair#727) — so an existing file only
  // forces the manual-print fallback when it's genuinely unreadable/
  // unwritable (permissions, I/O error), never merely "exists".
  //
  // flair#1135: the "already wired" check is now version-aware — a section
  // with a stale pin triggers a re-write instead of a no-op.
  const path = codexConfigPath();
  const display = "~/.codex/config.toml";
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      if (codexFlairSectionHasCurrentPin(raw)) {
        return { ok: true, message: `Codex: already wired in ${display}` };
      }
      if (codexConfigHasFlairSection(raw)) {
        // Section exists but pin is stale — replace it.
        writeFileSync(path, replaceCodexFlairBlock(raw, env));
        return { ok: true, message: `Codex: refreshed pin in ${display} (restart Codex to pick it up)` };
      }
      writeFileSync(path, appendCodexFlairBlock(raw, env));
      return { ok: true, message: `Codex: wired ${display} (restart Codex to pick it up)` };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tomlSnippet(env) + "\n");
    return { ok: true, message: `Codex: wired ${display} (restart Codex to pick it up)` };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Codex: manual wiring needed (could not write ${display}: ${reason}).\n` +
        `   Add this block to ${display}:\n${indent(tomlSnippet(env))}`,
    };
  }
}

function _wireGemini(env: WireEnv): { ok: boolean; message: string } {
  return wireJsonMcp(geminiConfigPath(), "Gemini", env);
}

function _wireCursor(env: WireEnv): { ok: boolean; message: string } {
  return wireJsonMcp(cursorConfigPath(), "Cursor", env);
}

// Antigravity uses the same standard JSON `mcpServers` stdio schema as Gemini/
// Cursor (command/args/env), so wireJsonMcp merges into it byte-identically —
// only the config PATH differs (flair#1209).
//
// The success message deliberately does NOT claim "restart Antigravity to pick
// it up": Flair writes the config to the documented path, but has not verified
// end-to-end that a live `agy` reads it. So the message claims only the write,
// and asks the user to confirm pickup (flair#1209 review — honesty on an
// unverified integration).
function _wireAntigravity(env: WireEnv): { ok: boolean; message: string } {
  return wireJsonMcp(
    antigravityConfigPath(),
    "Antigravity",
    env,
    "wiring unverified against a real agy — restart Antigravity and confirm the flair tools appear",
  );
}

// ---- Exported detection & wiring array ------------------------------------------

export const ALL_CLIENTS: Omit<Client, "detected">[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    kind: "mcp",
    wire: _wireClaudeCode,
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    kind: "mcp",
    wire: _wireCodex,
  },
  {
    id: "gemini",
    label: "Gemini",
    bin: "gemini",
    kind: "mcp",
    wire: _wireGemini,
  },
  {
    id: "cursor",
    label: "Cursor",
    bin: "cursor",
    kind: "mcp",
    wire: _wireCursor,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // Google's Antigravity CLI — the executable is `agy` (flair#1209).
    bin: "agy",
    kind: "mcp",
    wire: _wireAntigravity,
  },
  {
    id: "pi",
    label: "pi",
    bin: "pi",
    // NOT an MCP client — pi loads @tpsdev-ai/pi-flair as a native extension
    // via its settings.json `packages` key (flair#1342). Consumers doing
    // MCP-shaped work must filter on `kind`.
    kind: "native-extension",
    // pi is also detected by its settings file: a configured pi whose binary
    // isn't on THIS shell's PATH (version manager, launchd context) is still
    // a pi whose wiring is worth checking/fixing. Pure fs check, both legs.
    detect: () => detectBin("pi") || existsSync(piSettingsPath()),
    wire: _wirePi,
  },
];

// ---- End-of-run wiring summary (flair#906) --------------------------------

/** One client's outcome. `wired` means a config file was actually written. */
export interface WiringOutcome {
  client: string;
  message: string;
  wired: boolean;
}

/** A summary line, tagged with severity so the caller owns icon/colour. */
export interface SummaryLine {
  level: "heading" | "ok" | "error" | "warn" | "muted";
  text: string;
}

/**
 * The summary `flair init` prints LAST.
 *
 * Every fact here was already available mid-run — `wiringResults` has always
 * distinguished "wired ~/.claude.json" from "snippet printed (no
 * ~/.claude.json)". What was missing is a place where the difference is still
 * on screen once the command finishes: a not-wired client showed up only as a
 * snippet in the middle of a wall of output, *after* a success line, so
 * `--client all` read as having done all of it (flair#906). Pure so it can be
 * tested without running init.
 */
export function renderWiringSummary(
  results: WiringOutcome[],
  opts: {
    labels?: Map<string, string>;
    /** Clients `--client all` passed over because they aren't installed. */
    skippedUndetected?: string[];
    /** Command to suggest when nothing at all got wired. */
    rewireHint?: string;
    /** True when the written spec could not be pinned (flair#907). */
    unpinned?: boolean;
  } = {},
): SummaryLine[] {
  const label = (id: string) => opts.labels?.get(id) ?? id;
  const skipped = opts.skippedUndetected ?? [];
  const wired = results.filter(r => r.wired);
  const notWired = results.filter(r => !r.wired);

  if (results.length === 0 && skipped.length === 0) return [];

  const lines: SummaryLine[] = [{ level: "heading", text: "MCP clients" }];

  if (wired.length > 0) {
    lines.push({ level: "ok", text: `Wired: ${wired.map(r => label(r.client)).join(", ")}` });
  }
  // One line per NOT-wired client, naming the client and why — a count alone
  // ("1 client failed") sends the user back to scrollback to find which.
  for (const r of notWired) {
    lines.push({ level: "error", text: `NOT wired: ${label(r.client)} — ${r.message}` });
  }
  if (skipped.length > 0) {
    lines.push({ level: "muted", text: `Not installed, skipped: ${skipped.join(", ")}` });
  }
  if (wired.length === 0 && notWired.length === 0) {
    lines.push({
      level: "warn",
      text: opts.rewireHint
        ? `No MCP client was wired. Install a client, then re-run: ${opts.rewireHint}`
        : "No MCP client was wired.",
    });
  }
  if (notWired.length > 0) {
    lines.push({
      level: "warn",
      text: `${notWired.length} client(s) need manual wiring — see the config printed above, or docs/mcp-clients.md`,
    });
  }
  if (opts.unpinned) {
    lines.push({
      level: "warn",
      text: "MCP server wired UNPINNED (Flair could not read its own version) — see the warning above.",
    });
  }
  return lines;
}

/**
 * Detect every known client. One rule (`bin` on PATH) applied uniformly — a
 * client added to ALL_CLIENTS is detected by declaring its executable, with no
 * per-client branch here to forget to extend. A client may widen that with a
 * declared `detect` override (still a pure fs check — pi adds its settings
 * file as a second signal, flair#1342); the override lives on the registry
 * entry, so this function stays branch-free.
 */
export function detectClients(): Client[] {
  return ALL_CLIENTS.map((client) => ({
    ...client,
    detected: client.detect ? client.detect() : detectBin(client.bin),
  }));
}

export function wireClaudeCode(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireClaudeCode(env);
}

export function wireCodex(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireCodex(env);
}

export function wireGemini(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireGemini(env);
}

export function wireCursor(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireCursor(env);
}

export function wireAntigravity(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wireAntigravity(env);
}

export function wirePi(
  env: WireEnv
): { ok: boolean; message: string } {
  return _wirePi(env);
}
