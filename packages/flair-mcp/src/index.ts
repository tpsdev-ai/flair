#!/usr/bin/env node

/**
 * Flair MCP Server — persistent memory for Claude Code and any MCP client.
 *
 * Tools (derived from @tpsdev-ai/flair-tool-descriptors — flair#1580):
 *   - memory_search  — semantic search across memories
 *   - memory_store   — save a memory with type + durability
 *   - memory_update  — update an existing memory by ID (dedup-bypassed)
 *   - memory_get     — retrieve a specific memory by ID
 *   - memory_delete  — delete a memory
 *   - relationship_store — assert a subject/predicate/object relationship triple
 *   - bootstrap      — cold-start context (soul + recent memories)
 *   - soul_set       — set a personality/context entry
 *   - soul_get       — get a personality/context entry
 *   - flair_workspace_set — write own WorkspaceState (Office Space coordination)
 *   - flair_orgevent      — publish an OrgEvent attributed to self (no forging)
 *   - record_usage        — report that recalled memories were actually used (flair#1147)
 *   - skill_store         — write a skill-tagged memory (trigger + procedure)
 *   - skill_search        — catalog skills that apply to a task (not the procedure)
 *   - skill_get           — retrieve the full skill by id (disclosure after search)
 *
 * Auto-presence (flair#598): every tool call above triggers a fire-and-forget,
 * rate-limited `POST /Presence` heartbeat for the calling agent (see
 * ./presence.ts + the `heartbeat()` closure in runMcp()) — presence is now a
 * side effect of normal activity instead of the manual `flair presence set`
 * CLI command nobody ran. `bootstrap` additionally seeds the activity/task
 * from its own arguments (session start signal).
 *
 * Usage:
 *   npx -y @tpsdev-ai/flair-mcp
 *
 * Claude Code .mcp.json:
 *   { "mcpServers": { "flair": { "command": "npx", "args": ["-y", "@tpsdev-ai/flair-mcp"] } } }
 *
 * BIN ENTRY / NODE-VERSION PREFLIGHT
 * ----------------------------------
 * The published `flair-mcp` bin is NOT this file — it is the CommonJS preflight
 * shim (dist/mcp-shim.cjs, compiled from src/mcp-shim.cts). This module is an
 * ES module: its top-level imports are hoisted and the whole graph is linked +
 * evaluated before any in-file guard could run, so on an old Node it crashes
 * during linking (the SDK + flair deps need Node >= 22) before printing anything
 * — the silent `npx -y @tpsdev-ai/flair-mcp` failure. The shim checks the Node
 * version FIRST, then dynamically imports this module and calls runMcp().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlairClient } from "@tpsdev-ai/flair-client";
import {
  deriveActivity,
  postPresenceSafe,
  resolveHeartbeatIntervalMs,
  resolvePresenceTimeoutMs,
  shouldSendHeartbeat,
  type PresenceActivity,
} from "./presence.js";
import { readEnvOrUnset, stripInterpolationLiteralsFromEnv } from "./env-guard.js";
import { serverInfo } from "./version.js";
import { registerStdioTools } from "./adapter-tools.js";

export { classifyError } from "./errors.js";

// ─── Entry point ──────────────────────────────────────────────────────────────
//
// runMcp() is the real entry point. It is exported so the CommonJS preflight
// shim (mcp-shim.cts → dist/mcp-shim.cjs, the published bin) can invoke it after
// its Node-version check passes — the shim imports this module, so a top-level
// `import.meta.main` guard would be false there. Everything that has runtime
// side effects (the FLAIR_AGENT_ID check, FlairClient construction, the parent-
// exit watcher, tool registration, and the stdio connect) lives inside runMcp()
// so that merely importing this module (e.g. from the shim before the version
// check, or from a test) does nothing until runMcp() is called.
export async function runMcp(): Promise<void> {
  // ─── Parent-exit watcher ──────────────────────────────────────────────────
  //
  // flair-mcp runs as a child of an MCP host (Claude Code, Cursor, etc) over
  // stdio. When the host exits cleanly it should close stdin/stdout — but in
  // practice we've seen flair-mcp processes orphaned for weeks (PID 1 as
  // parent), holding stale tokens and consuming RAM.
  //
  // Poll process.ppid every 5s. If it drops to 1 (init), the parent died and
  // we got reparented — exit cleanly. Cheap, cross-platform, no native deps.

  // Clamp the poll interval to a safe range. `process.env.FOO ?? 5000` is NOT
  // safe on its own: `??` only falls through on null/undefined, so an empty-string
  // override (`FLAIR_MCP_PARENT_POLL_MS=`) yields `Number("") === 0` and creates
  // a tight CPU-busy loop. Validate explicitly. (Sherlock review on #315.)
  const PARENT_POLL_INTERVAL_MS = (() => {
    const raw = process.env.FLAIR_MCP_PARENT_POLL_MS;
    const parsed = raw != null ? Number(raw) : NaN;
    const FLOOR_MS = 100;
    const CEILING_MS = 30_000;
    return Number.isFinite(parsed) && parsed >= FLOOR_MS && parsed <= CEILING_MS
      ? parsed
      : 5000;
  })();
  const initialPpid = process.ppid;
  setInterval(() => {
    // ppid === 1 means init/launchd has adopted us — original parent died.
    if (process.ppid === 1 && initialPpid !== 1) {
      console.error("flair-mcp: parent process died (re-parented to init); exiting cleanly.");
      process.exit(0);
    }
  }, PARENT_POLL_INTERVAL_MS).unref();

  // Also handle stdin EOF — MCP host closing the pipe means session ended.
  // (StdioServerTransport handles this internally for the MCP protocol, but
  // belt-and-suspenders: if stdin closes we exit, full stop.)
  process.stdin.on("close", () => {
    console.error("flair-mcp: stdin closed; exiting cleanly.");
    process.exit(0);
  });
  process.stdin.on("end", () => {
    console.error("flair-mcp: stdin EOF; exiting cleanly.");
    process.exit(0);
  });

  // ─── Client setup ────────────────────────────────────────────────────────────

  // flair#1250: an MCP host that forwards `"FLAIR_URL": "${FLAIR_URL}"` without
  // substituting hands us the literal `${FLAIR_URL}`. Remove such literals from
  // the process env first, because flair-client's constructor ALSO reads
  // process.env.FLAIR_URL as a fallback — guarding only our own reads below
  // would be silently defeated when flair-client re-reads the raw env.
  stripInterpolationLiteralsFromEnv();

  const agentId = readEnvOrUnset("FLAIR_AGENT_ID");
  if (!agentId) {
    console.error("FLAIR_AGENT_ID is required. Set it in your .mcp.json env or shell.");
    process.exit(1);
  }

  const flair = new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
    // flair#718 authorship-provenance: forward this stdio proxy's own
    // FLAIR_CLIENT env (set by `flair init`'s per-client wiring, e.g.
    // "claude-code"/"codex"/"gemini"/"cursor") into the client it constructs
    // — explicit here rather than relying solely on FlairClient's own
    // process.env fallback, so the forwarding is visible at this call site.
    // Absent = omitted, zero behavior change for un-wired installs.
    claimedClient: process.env.FLAIR_CLIENT,
  });

  // ─── Auto-presence (flair#598) ────────────────────────────────────────────────
  //
  // Presence used to be manual-only (`flair presence set`, which in practice
  // nobody runs) — so the roster was permanently stale and the collision-
  // detection it exists for never worked. This makes presence a SIDE EFFECT of
  // normal agent activity instead: `bootstrap` (session start) always attempts
  // a heartbeat, and every other tool call attempts one too, both routed
  // through the SAME rate-limited, fire-and-forget `heartbeat()` below so
  // repeated bootstrap calls in a short window don't spam any more than
  // repeated tool calls would.
  //
  // A SEPARATE FlairClient instance, not the main `flair` above — its own
  // short `timeoutMs` (resolvePresenceTimeoutMs(), default 3s vs the main
  // client's general-purpose 30s default) means a dead/slow daemon can never
  // make a presence write outlive the tool call it rode in on, independent of
  // whatever timeout the main client is configured with.
  const presenceFlair = new FlairClient({
    agentId,
    url: readEnvOrUnset("FLAIR_URL"),
    keyPath: readEnvOrUnset("FLAIR_KEY_PATH"),
    timeoutMs: resolvePresenceTimeoutMs(),
  });

  // Rate-limit clock + last-known task, in-process only (no persistence —
  // resets on restart, which is fine; the next tool call re-establishes it).
  // Owned here, not in presence.ts, so the pure rate-limit/body-building logic
  // stays testable without any shared mutable state.
  let lastPresenceSentAt: number | null = null;
  // currentTask is the caller's responsibility to preserve (see
  // postPresenceSafe's doc comment): Presence.post() treats an ABSENT
  // currentTask as an explicit clear, so a heartbeat that doesn't know about
  // an in-flight task must keep resending the last one bootstrap() told us
  // about, or it would silently erase it every ~3 minutes.
  let lastKnownTask: string | undefined;

  /**
   * Fire-and-forget, rate-limited presence heartbeat. Safe to call from every
   * tool handler unconditionally — the rate limit + postPresenceSafe's
   * internal catch-everything mean this NEVER throws, NEVER awaits network
   * I/O in the caller's path, and NEVER delays the tool response. The
   * `.catch(() => {})` below is belt-and-suspenders (postPresenceSafe already
   * never rejects) purely so a future change to that function can't
   * accidentally reintroduce an unhandled rejection here.
   */
  function heartbeat(activity: PresenceActivity = "coding"): void {
    const now = Date.now();
    if (!shouldSendHeartbeat(now, lastPresenceSentAt, resolveHeartbeatIntervalMs())) return;
    lastPresenceSentAt = now; // set synchronously, before the async write, so a burst of
    // tool calls in the same tick can't all slip past the rate limit together
    postPresenceSafe(presenceFlair, activity, lastKnownTask, resolvePresenceTimeoutMs()).catch(() => {});
  }

  // ─── MCP Server ──────────────────────────────────────────────────────────────

  const server = new McpServer(serverInfo());

  // ─── Tools (derived from @tpsdev-ai/flair-tool-descriptors) ───────────────
  //
  // The advertised set is STDIO_TOOL_DESCRIPTORS. Handlers bind each
  // descriptor to a FlairClient HTTP call. A new shared descriptor appears
  // here for free once a FlairClient binding exists — no per-tool literals.

  registerStdioTools(server, {
    flair,
    agentId,
    heartbeat,
    rememberTask: (task) => {
      if (task) lastKnownTask = task;
    },
  });

  // ─── Start ───────────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Entry point dispatch ──────────────────────────────────────────────────────
//
// Run directly when this module is the entry point — covers `bun src/index.ts`
// and `node dist/index.js`. The packaged bin goes through mcp-shim.cjs → runMcp()
// after its Node-version check, so import.meta.main is false there; without this
// the server would never start when invoked through the shim. (Matches the
// session-start-hook + CLI shim entry-point pattern.)
const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMain =
  importMeta.main === true ||
  (typeof process !== "undefined" &&
    process.argv[1] != null &&
    import.meta.url === `file://${process.argv[1]}`);

if (isMain) {
  void runMcp().catch((err) => {
    console.error(err && (err as Error).stack ? (err as Error).stack : err);
    process.exit(1);
  });
}
