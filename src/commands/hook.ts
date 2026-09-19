/**
 * hook.ts — `flair hook` command group (flair#1627 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration (install / uninstall / status), its action
 * handlers, and the two group-specific inline helpers (`resolveHookFlairUrl`,
 * `requireSupportedHarness`). All mutation logic still lives in
 * src/hook-install.ts; this module stays pure CLI plumbing. The one shared
 * cli.ts-local helper it needs (`resolveBaseUrl`) is bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import { homedir } from "node:os";
import * as render from "../render.js";
import { unpinnedSpecWarning } from "../lib/mcp-spec.js";
import { probeSessionStartHookDelivery, readClientMcpBlock } from "../doctor-client.js";
import {
  installHook,
  uninstallHook,
  hookStatus,
  hookStatusHeadline,
  hookStatusFailureLine,
  hookStatusIdentityLines,
  HOOK_STATUS_UNPARSED,
  installContinuityHooks,
  uninstallContinuityHooks,
  continuityHookStatus,
  isSupportedHarness,
  SUPPORTED_HARNESSES,
  hookInstallHint,
  harnessSupportsContinuity,
  resolveHookAgentId,
  type Harness,
} from "../hook-install.js";

export type HookCli = {
  resolveBaseUrl: (opts: { target?: string; url?: string; port?: string | number }) => string;
};

let cli: HookCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: HookCli): void {
  cli = fns;
}

function resolveBaseUrl(opts: { target?: string; url?: string; port?: string | number }): string {
  return cli.resolveBaseUrl(opts);
}

/** Register the `flair hook` command group. */
export function register(program: Command): void {
  // ─── flair hook ──────────────────────────────────────────────────────────────
  // Ambient memory via harness SessionStart hooks (flair#745, design record
  // #719 — the "Paved-paths" round). `flair doctor --fix`/`flair init` already
  // wire the same SessionStart hook as a side effect of a bigger flow; this is
  // the standalone, symmetric command family (install/uninstall/status) an
  // operator or a headless/scheduled setup script can run on its own. All the
  // mutation logic (fail-closed on malformed settings.json, idempotent merge,
  // dry-run delta, symmetric removal) lives in src/hook-install.ts — this
  // section is pure CLI plumbing: option parsing, default resolution, and
  // rendering the pure functions' results.

  function resolveHookFlairUrl(opts: { url?: string }, homeDir: string, harness: Harness): string {
    return (
      opts.url ||
      process.env.FLAIR_TARGET ||
      process.env.FLAIR_URL ||
      readClientMcpBlock(harness, homeDir).flairUrl ||
      (harness !== "claude-code" ? readClientMcpBlock("claude-code", homeDir).flairUrl : undefined) ||
      resolveBaseUrl({})
    );
  }

  function requireSupportedHarness(raw: string | undefined): Harness {
    const name = raw || "claude-code";
    if (!isSupportedHarness(name)) {
      console.error(`Unknown harness '${name}'. Supported: ${SUPPORTED_HARNESSES.join(", ")}`);
      process.exit(1);
    }
    return name;
  }

  const hook = program.command("hook").description("Manage ambient-memory harness SessionStart hooks (flair#745)");

  hook
    .command("install")
    .description("Wire the Flair SessionStart hook into the harness config so memory loads automatically at session start")
    .option("--harness <name>", `Target harness (${SUPPORTED_HARNESSES.join(", ")})`, "claude-code")
    .option("--dry-run", "Print the exact JSON delta without writing")
    .option("--agent <id>", "Agent ID to wire (else FLAIR_AGENT_ID, else the agent already wired for this harness's MCP client)")
    .option("--agent-id <id>", "Alias for --agent")
    .option("--url <url>", "Flair URL to wire (else FLAIR_TARGET/FLAIR_URL, else this harness's MCP wiring, else the local default)")
    .option("--continuity", "Wire the continuity capture hooks instead (PostToolUse + Stop — flair#1257; installing them IS the opt-in)")
    .action((opts) => {
      const harness = requireSupportedHarness(opts.harness);
      const home = homedir();
      const agentId = resolveHookAgentId(opts, home, harness);
      if (!agentId) {
        console.error(
          "No agent id known — pass --agent <id>, set FLAIR_AGENT_ID, or run `flair init` / `flair agent add` first.",
        );
        process.exit(1);
      }
      const flairUrl = resolveHookFlairUrl(opts, home, harness);
      const dryRun = !!opts.dryRun;

      if (opts.continuity) {
        const result = installContinuityHooks({ homeDir: home, harness, agentId, flairUrl, dryRun });
        console.log(`\n${render.wrap(render.c.bold, "🪝 flair hook install --continuity")}${dryRun ? render.wrap(render.c.dim, " (dry run)") : ""}\n`);
        console.log(`  ${result.ok ? render.icons.ok : render.icons.error} ${result.message}`);
        if (result.backupPath) {
          console.log(`     ${render.wrap(render.c.dim, `backup: ${result.backupPath}`)}`);
        }
        console.log("");
        if (!result.ok) process.exit(1);
        return;
      }

      const result = installHook({ homeDir: home, harness, agentId, flairUrl, dryRun });

      console.log(`\n${render.wrap(render.c.bold, "🪝 flair hook install")}${dryRun ? render.wrap(render.c.dim, " (dry run)") : ""}\n`);
      console.log(`  ${result.ok ? render.icons.ok : render.icons.error} ${result.message}`);
      const pinWarning = unpinnedSpecWarning();
      if (pinWarning && result.ok) {
        for (const line of pinWarning.split("\n")) console.error(`   ⚠ ${line}`);
      }
      if (result.backupPath) {
        console.log(`     ${render.wrap(render.c.dim, `backup: ${result.backupPath}`)}`);
      }
      if (result.delta) {
        console.log(`\n  ${render.wrap(render.c.dim, `${dryRun ? "would apply" : "applied"} (${result.delta.action}):`)}`);
        console.log(render.asJSON(result.delta));
      }
      console.log("");
      if (!result.ok) process.exit(1);
    });

  hook
    .command("uninstall")
    .description("Remove the Flair SessionStart hook entry — only ours, everything else in the file is left untouched")
    .option("--harness <name>", `Target harness (${SUPPORTED_HARNESSES.join(", ")})`, "claude-code")
    .option("--dry-run", "Print the exact JSON delta without writing")
    .option("--continuity", "Remove the continuity capture hooks instead (PostToolUse + Stop — flair#1257)")
    .action((opts) => {
      const harness = requireSupportedHarness(opts.harness);
      const home = homedir();
      const dryRun = !!opts.dryRun;

      if (opts.continuity) {
        const result = uninstallContinuityHooks({ homeDir: home, harness, dryRun });
        console.log(`\n${render.wrap(render.c.bold, "🪝 flair hook uninstall --continuity")}${dryRun ? render.wrap(render.c.dim, " (dry run)") : ""}\n`);
        console.log(`  ${result.ok ? render.icons.ok : render.icons.error} ${result.message}`);
        if (result.backupPath) {
          console.log(`     ${render.wrap(render.c.dim, `backup: ${result.backupPath}`)}`);
        }
        console.log("");
        if (!result.ok) process.exit(1);
        return;
      }

      const result = uninstallHook({ homeDir: home, harness, dryRun });

      console.log(`\n${render.wrap(render.c.bold, "🪝 flair hook uninstall")}${dryRun ? render.wrap(render.c.dim, " (dry run)") : ""}\n`);
      console.log(`  ${result.ok ? render.icons.ok : render.icons.error} ${result.message}`);
      if (result.backupPath) {
        console.log(`     ${render.wrap(render.c.dim, `backup: ${result.backupPath}`)}`);
      }
      if (result.delta) {
        console.log(`\n  ${render.wrap(render.c.dim, `${dryRun ? "would apply" : "applied"} (${result.delta.action}):`)}`);
        console.log(render.asJSON(result.delta));
      }
      console.log("");
      if (!result.ok) process.exit(1);
    });

  hook
    .command("status")
    .description("Show whether the SessionStart hook is wired, its shape, and which Flair instance it targets")
    .option("--harness <name>", `Target harness (${SUPPORTED_HARNESSES.join(", ")})`, "claude-code")
    .action((opts) => {
      const harness = requireSupportedHarness(opts.harness);
      const home = homedir();
      const status = hookStatus(home, harness, {
        deliveryProbe: (command) => probeSessionStartHookDelivery(command),
      });

      // Continuity pair (flair#1257) — reported alongside the SessionStart
      // status in every branch below. "absent" is NOT a failure: installing the
      // pair is the opt-in, so absence renders as "not enabled".
      const renderContinuity = (): void => {
        // Continuity is Claude Code only. Do not tip `--continuity --harness
        // <other>` — that writes Claude tool matchers into the wrong file.
        if (!harnessSupportsContinuity(harness)) return;
        const cont = continuityHookStatus(home, harness);
        if (cont.state === "installed") {
          console.log(`  ${render.icons.ok} continuity capture: PostToolUse + Stop wired`);
        } else if (cont.state === "absent") {
          console.log(`  ${render.icons.info} continuity capture: not enabled ${render.wrap(render.c.dim, `(opt-in: ${hookInstallHint(harness, "--continuity")})`)}`);
        } else {
          const missing = !cont.postToolUse.present ? "PostToolUse missing" : !cont.stop.present ? "Stop missing" : "stale form";
          console.log(`  ${render.icons.warn} continuity capture: ${cont.state} (${missing}) ${render.wrap(render.c.dim, `— re-run: ${hookInstallHint(harness, "--continuity")}`)}`);
        }
      };

      console.log(`\n${render.wrap(render.c.bold, "🪝 flair hook status")}\n`);
      console.log(`  ${render.wrap(render.c.dim, "Harness:")} ${status.harness}`);
      console.log(`  ${render.wrap(render.c.dim, "Config:")}  ${status.path}`);

      if (status.parseError) {
        console.log(`  ${render.icons.error} ${status.parseError}`);
        console.log("");
        process.exit(1);
      }

      if (!status.wired) {
        console.log(`  ${render.icons.error} ${hookStatusHeadline(status)}`);
        console.log(`     ${render.wrap(render.c.dim, "Fix:")} ${hookInstallHint(status.harness)}`);
        renderContinuity();
        console.log("");
        process.exit(1);
      }

      const headline = hookStatusHeadline(status);
      const verified = status.delivery === "verified" && status.correctShape;
      console.log(`  ${verified ? render.icons.ok : render.icons.warn} ${headline}${status.correctShape ? "" : " (unexpected shape — was it hand-edited?)"}`);
      for (const reason of status.deliveryReasons) {
        console.log(`     ${render.wrap(render.c.dim, reason)}`);
      }
      // flair#1325 — skip the URL line only when agentId was recovered
      // (the installer form that omits FLAIR_URL). A wired correct-shape
      // command with no env assignments still prints unknown, not a
      // silent all-clear.
      for (const line of hookStatusIdentityLines(status)) {
        const label = line.label === "Agent" ? "Agent:    " : "Flair URL:";
        const value = line.value === HOOK_STATUS_UNPARSED ? render.wrap(render.c.dim, line.value) : line.value;
        console.log(`     ${render.wrap(render.c.dim, label)} ${value}`);
      }
      // flair#1007 / #1734 — session-continue vs stderr visibility.
      const failure = hookStatusFailureLine(status);
      if (status.stderrDiscarded) {
        console.log(`     ${render.wrap(render.c.dim, "On failure:")} ${failure}`);
      } else if (status.silenced) {
        console.log(`     ${render.wrap(render.c.dim, "On failure:")} ${failure}`);
      } else {
        console.log(`     ${render.icons.warn} ${render.wrap(render.c.dim, "On failure:")} ${failure} — run \`${hookInstallHint(status.harness)}\` to adopt the silent form`);
      }
      renderContinuity();
      console.log("");
    });
}
