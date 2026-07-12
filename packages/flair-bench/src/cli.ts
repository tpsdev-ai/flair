/**
 * cli.ts — thin argv-parsing bin. Parses process.argv into the options
 * objects index.ts's API expects, calls that API, formats the result
 * (format.ts), and prints — this file is the ONLY place in the package that
 * calls console.log/console.error/process.exit(code) (process.exitCode is
 * used, not process.exit(), so a caller that imports runCli() programmatically
 * doesn't get its own process killed).
 *
 * Deliberately thin: the future `flair bench` subcommand (see README
 * "Library use") is expected to import index.ts's runBenchmark()/recommend()
 * directly and do its own argv parsing / rendering inside the main `flair`
 * CLI's existing command tree, not shell out to this file.
 */

import { readFileSync } from "node:fs";
import { runBenchmark, recommend, buildShareDocument, writeShareDocument, SUBMISSION_ENDPOINT_PLACEHOLDER, TOOL_VERSION } from "./index.js";
import { formatPretty, formatJson, formatRecommendPretty, formatRecommendJson } from "./format.js";
import type { BenchOptions, BenchProgressEvent, RecommendOptions } from "./types.js";

const HELP = `flair-bench ${TOOL_VERSION} — standalone embedding recall benchmark for flair

USAGE:
  flair-bench run [options]
  flair-bench recommend [options]

OPTIONS:
  --model-file <path>       GGUF file to benchmark. Repeatable for a batch.
  --manifest <path>         Text file, one GGUF path per line (# comments, blank lines ignored).
                             Combines with any --model-file flags.
  --label <string>          Freeform host/infra label (e.g. "fabric-gpu-a", "local-m4-mini") — becomes
                             the grouping key in output and in --share's hardware block. Never a
                             hostname; nothing is auto-filled from this machine's actual hostname.
  --warmup-n <int>          Untimed warmup embeds before ms/embed timing starts. Default 8.
  --json                    Emit machine-readable JSON instead of the pretty text report.
  --pretty                  Emit the pretty text report (default).
  --share                   Also write a canonical, redacted result JSON per model to disk
                             (see --share-out). Prints where the endpoint submission would go,
                             once one exists — no network call is made.
  --share-out <dir>         Directory for --share output. Default: current directory.

RECOMMEND-ONLY OPTIONS:
  --ram-headroom <fraction> Fraction of available RAM a model's peak RSS delta may use. Default 0.5.
  --latency-threshold <ms>  ms/embed ceiling for a model to be considered usable. Default 500.

PRIVACY NOTE:
  --share writes model identity (name, file basename, sha256, quant, dims) and a host
  fingerprint (platform, arch, CPU model, RAM, GPU backend/device string, and your --label)
  plus the measured recall/latency/memory numbers. It NEVER includes a hostname, filesystem
  path, or username — see the package README's "Share schema" section for the exact shape.
`;

interface ParsedArgs {
  command: "run" | "recommend" | "help";
  modelFiles: string[];
  label?: string;
  warmupN?: number;
  json: boolean;
  share: boolean;
  shareOut?: string;
  ramHeadroom?: number;
  latencyThreshold?: number;
}

function readManifest(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] === "run" || args[0] === "recommend" ? args[0] : args[0] === "--help" || args[0] === "-h" || args[0] === undefined ? "help" : undefined;
  if (command === undefined) {
    throw new Error(`Unknown command "${args[0]}" — expected "run" or "recommend" (see --help)`);
  }

  const modelFiles: string[] = [];
  let label: string | undefined;
  let warmupN: number | undefined;
  let json = false;
  let share = false;
  let shareOut: string | undefined;
  let ramHeadroom: number | undefined;
  let latencyThreshold: number | undefined;

  for (let i = command === "help" ? 0 : 1; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      i++;
      if (i >= args.length) throw new Error(`${a} requires a value`);
      return args[i]!;
    };
    switch (a) {
      case "--model-file":
        modelFiles.push(next());
        break;
      case "--manifest":
        modelFiles.push(...readManifest(next()));
        break;
      case "--label":
        label = next();
        break;
      case "--warmup-n":
        warmupN = Number(next());
        break;
      case "--json":
        json = true;
        break;
      case "--pretty":
        json = false;
        break;
      case "--share":
        share = true;
        break;
      case "--share-out":
        shareOut = next();
        break;
      case "--ram-headroom":
        ramHeadroom = Number(next());
        break;
      case "--latency-threshold":
        latencyThreshold = Number(next());
        break;
      case "--help":
      case "-h":
        return { command: "help", modelFiles, json, share };
      default:
        throw new Error(`Unknown option "${a}" (see --help)`);
    }
  }

  return { command, modelFiles, label, warmupN, json, share, shareOut, ramHeadroom, latencyThreshold };
}

function onProgress(event: BenchProgressEvent): void {
  switch (event.type) {
    case "host-fingerprinted":
      console.error(`[flair-bench] host: ${event.host.platform}/${event.host.arch} backend=${event.host.backend}`);
      break;
    case "model-start":
      console.error(`[flair-bench] (${event.index + 1}/${event.total}) loading ${event.fileName}...`);
      break;
    case "model-loaded":
      console.error(`[flair-bench] loaded ${event.fileName} in ${event.loadTimeMs.toFixed(0)}ms — embedding corpus...`);
      break;
    case "model-embedding":
      if (event.done % 64 === 0 || event.done === event.total) {
        console.error(`[flair-bench]   ${event.fileName}: ${event.done}/${event.total} embedded`);
      }
      break;
    case "model-done":
      console.error(`[flair-bench] ${event.fileName} done — p@3=${event.result.aggregate.p3.toFixed(3)} MRR=${event.result.aggregate.mrr.toFixed(3)}`);
      break;
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error("");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  if (parsed.command === "help") {
    console.log(HELP);
    return;
  }

  if (parsed.modelFiles.length === 0) {
    console.error(`"${parsed.command}" requires at least one --model-file (or --manifest). See --help.`);
    process.exitCode = 1;
    return;
  }

  try {
    if (parsed.command === "run") {
      const options: BenchOptions = { modelFiles: parsed.modelFiles, label: parsed.label, warmupN: parsed.warmupN, onProgress };
      const result = await runBenchmark(options);
      console.log(parsed.json ? formatJson(result) : formatPretty(result));
      if (parsed.share) {
        for (const m of result.models) {
          const doc = buildShareDocument(m, result.host);
          const written = writeShareDocument(doc, parsed.shareOut);
          console.log(`\n${written.endpointNote}`);
          console.log(`(submission endpoint placeholder: ${SUBMISSION_ENDPOINT_PLACEHOLDER} — not live, no network call was made)`);
        }
      }
    } else {
      const options: RecommendOptions = {
        modelFiles: parsed.modelFiles,
        label: parsed.label,
        warmupN: parsed.warmupN,
        ramHeadroomFraction: parsed.ramHeadroom,
        latencyThresholdMsPerEmbed: parsed.latencyThreshold,
        onProgress,
      };
      const result = await recommend(options);
      console.log(parsed.json ? formatRecommendJson(result) : formatRecommendPretty(result));
      if (parsed.share) {
        for (const m of result.batch.models) {
          const doc = buildShareDocument(m, result.batch.host);
          const written = writeShareDocument(doc, parsed.shareOut);
          console.log(`\n${written.endpointNote}`);
          console.log(`(submission endpoint placeholder: ${SUBMISSION_ENDPOINT_PLACEHOLDER} — not live, no network call was made)`);
        }
      }
    }
  } catch (err) {
    console.error(`[flair-bench] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
