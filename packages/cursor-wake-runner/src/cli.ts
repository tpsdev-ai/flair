#!/usr/bin/env bun
/**
 * cursor-flair-wake — the #1613 consume + wake runner.
 *
 * Drains the configured agent's OrgEventCatchup (signed on live cycles) and launches
 * one Cursor Cloud Agent per directed coord.dispatch / a2a.message. Skipped events
 * and handoffs with written, verified or classified-refused receipts are ackable.
 * Reuses the client-supplied agentId on redelivery.
 */

import { FlairClient, inspectKeyLookup } from "@tpsdev-ai/flair-client";
import { HELP, loadConfig, parseArgs, type WakeConfig } from "./config.js";
import { runWakeCycle, type WakeResult } from "./run.js";

function printResult(result: WakeResult): void {
  const lines = [
    `Catchup: drained ${result.drained}, launched ${result.launched}, reused ${result.reused}, skipped ${result.skipped}.`,
  ];
  if (result.acked) lines.push(`acked: ${result.acked}`);
  if (result.blocked) lines.push(`blocked: ${result.blocked}`);
  if (result.receiptFailed) lines.push(`receipt failed: ${result.receiptFailed}`);
  if (result.receiptMismatched) lines.push(`receipt id conflict: ${result.receiptMismatched}`);
  for (const refused of result.receiptRefused) {
    lines.push(`receipt refused: ${refused.eventId} (HTTP ${refused.status}${refused.code ? ` ${refused.code}` : ""}; ackable without it)`);
  }
  for (const item of result.items) {
    const cursor = item.cursorAgentId ? ` ${item.cursorAgentId}` : "";
    const url = item.url ? ` ${item.url}` : "";
    const receipt = item.receipt ? ` receipt=${item.receipt}` : "";
    const reason = item.reason ? ` (${item.reason})` : "";
    lines.push(`  - [${item.action}] ${item.kind} ${item.eventId}${cursor}${url}${receipt}${reason}`);
  }
  console.log(lines.join("\n"));
}

/**
 * Existence-only CLI pre-check; dry-run skips it. The exported live cycle
 * loads and validates the Ed25519 key before any Flair or Cursor request.
 */
export function assertLiveSigningKey(config: WakeConfig): void {
  if (config.dryRun) return;
  const lookup = inspectKeyLookup(config.agentId, config.keyPath);
  if (lookup.resolvedPath === null) {
    throw new Error(
      `cursor-wake: live receipts need the agent's signing key — no Ed25519 key was found for FLAIR_AGENT_ID=${config.agentId} ` +
        "(checked FLAIR_KEY_PATH and ~/.flair/keys/<id>.key); set FLAIR_KEY_PATH to the agent's .key file " +
        "(admin Basic credentials are only for --dry-run)",
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig(flags);
  assertLiveSigningKey(config);
  const flair = new FlairClient({
    agentId: config.agentId,
    url: config.flairUrl,
    keyPath: config.keyPath,
    claimedClient: "cursor-wake",
  });

  const runOnce = async (): Promise<number> => {
    const result = await runWakeCycle({
      // The catchup reader and receipt store use this Flair client.
      client: flair,
      // The runner builds its Cursor client from this for a live cycle; a
      // dry-run cycle uses the dry-run client, which never CALLS Cursor (the
      // cycle still reads the agent's Flair feed).
      cursor: {
        apiBase: config.cursorApiBase,
        apiKey: config.cursorApiKey,
        repoUrl: config.repoUrl,
        startingRef: config.startingRef,
        envName: config.envName,
        envType: config.envType,
        autoCreatePr: config.autoCreatePr,
      },
      log: (line) => console.error(line),
      dryRun: config.dryRun,
      pageLimit: config.pageLimit,
    });
    printResult(result);
    return result.blocked || result.receiptFailed || result.receiptMismatched ? 2 : 0;
  };

  if (config.intervalSec === null) return runOnce();

  let code = 0;
  const tick = async () => {
    try {
      code = await runOnce();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      code = 1;
    }
  };
  const serial = startSerialTicks(tick, config.intervalSec);
  await new Promise<void>((resolve) => {
    const stop = () => {
      serial.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return code;
}

/**
 * flair#1944 round 2 — run `tick` now, then again only AFTER the previous tick
 * has settled. A fixed `setInterval` starts a new tick on a wall-clock schedule
 * whether or not the last cycle finished, so one runner can overlap its own
 * cycles (a slow drain or launch still in flight when the next begins). Here the
 * next tick is scheduled from the previous tick's completion, so at most one
 * cycle is ever in flight.
 *
 * `schedule`/`cancel` are injectable so a test can drive the clock; the CLI uses
 * real timers.
 */
export function startSerialTicks(
  tick: () => Promise<void>,
  intervalSec: number,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): { stop: () => void } {
  let stopped = false;
  let handle: unknown;
  const run = (): void => {
    void Promise.resolve()
      .then(tick)
      // tick owns its own error reporting; a throw must not stop the loop.
      .catch(() => {})
      .finally(() => {
        if (!stopped) handle = schedule(run, intervalSec * 1000);
      });
  };
  run();
  return {
    stop: () => {
      stopped = true;
      cancel(handle);
    },
  };
}

function invokedAsCli(): boolean {
  const entry = process.argv[1] ?? "";
  return /(?:^|[/\\])cli\.[cm]?[jt]s$/.test(entry) || /(?:^|[/\\])cursor-flair-wake$/.test(entry);
}

if (invokedAsCli()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
