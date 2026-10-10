#!/usr/bin/env bun
/**
 * cursor-flair-wake — the #1613 consume + wake runner.
 *
 * Drains THIS agent's OrgEventCatchup (signed FLAIR_AGENT_ID) and launches
 * one Cursor Cloud Agent per directed coord.dispatch / a2a.message. Ack
 * advances the watermark after handoff. Client-supplied agentId makes
 * redelivery a 409, not a second launch.
 */

import { FlairClient } from "@tpsdev-ai/flair-client";
import { createCatchupPort } from "./catchup.js";
import { HELP, loadConfig, parseArgs } from "./config.js";
import { createCursorAgentClient, dryRunCursorClient } from "./cursor-api.js";
import { createMemoryReceiptStore } from "./receipt-store.js";
import { runWakeCycle, type WakeResult } from "./run.js";

function printResult(result: WakeResult): void {
  const lines = [
    `Catchup: drained ${result.drained}, launched ${result.launched}, reused ${result.reused}, skipped ${result.skipped}.`,
  ];
  if (result.acked) lines.push(`acked: ${result.acked}`);
  if (result.blocked) lines.push(`blocked: ${result.blocked}`);
  if (result.receiptFailed) lines.push(`receipt failed: ${result.receiptFailed}`);
  for (const item of result.items) {
    const cursor = item.cursorAgentId ? ` ${item.cursorAgentId}` : "";
    const url = item.url ? ` ${item.url}` : "";
    const receipt = item.receipt ? ` receipt=${item.receipt}` : "";
    const reason = item.reason ? ` (${item.reason})` : "";
    lines.push(`  - [${item.action}] ${item.kind} ${item.eventId}${cursor}${url}${receipt}${reason}`);
  }
  console.log(lines.join("\n"));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig(flags);
  const flair = new FlairClient({
    agentId: config.agentId,
    url: config.flairUrl,
    keyPath: config.keyPath,
    claimedClient: "cursor-wake",
  });
  const catchup = createCatchupPort(flair);
  const cursor = config.dryRun
    ? dryRunCursorClient()
    : createCursorAgentClient({
        apiBase: config.cursorApiBase,
        apiKey: config.cursorApiKey,
        repoUrl: config.repoUrl,
        startingRef: config.startingRef,
        envName: config.envName,
        envType: config.envType,
        autoCreatePr: config.autoCreatePr,
      });

  const runOnce = async (): Promise<number> => {
    const result = await runWakeCycle({
      agentId: config.agentId,
      catchup,
      cursor,
      receipts: createMemoryReceiptStore(flair),
      log: (line) => console.error(line),
      dryRun: config.dryRun,
      pageLimit: config.pageLimit,
    });
    printResult(result);
    return result.blocked || result.receiptFailed ? 2 : 0;
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
  await tick();
  const timer = setInterval(tick, config.intervalSec * 1000);
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return code;
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
