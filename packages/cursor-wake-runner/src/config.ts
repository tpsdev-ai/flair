/**
 * Env / argv config for the wake-runner. There is deliberately no
 * `participant` / foreign-feed field — the runner always drains the
 * signed FLAIR_AGENT_ID.
 */

export interface WakeConfig {
  agentId: string;
  flairUrl?: string;
  keyPath?: string;
  cursorApiKey: string;
  cursorApiBase: string;
  repoUrl?: string;
  startingRef?: string;
  envName?: string;
  envType?: "cloud" | "pool" | "machine";
  autoCreatePr: boolean;
  intervalSec: number | null;
  dryRun: boolean;
  pageLimit?: number;
}

export interface CliFlags {
  once: boolean;
  intervalSec: number | null;
  dryRun: boolean;
  help: boolean;
  limit?: number;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 && !/^\$\{.+\}$/.test(value) ? value : undefined;
}

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { once: true, intervalSec: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--once") {
      flags.once = true;
      flags.intervalSec = null;
    } else if (arg === "--interval") {
      const raw = argv[i + 1];
      const n = raw !== undefined ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) throw new Error("--interval requires a positive number of seconds");
      flags.intervalSec = Math.trunc(n);
      flags.once = false;
      i += 1;
    } else if (arg === "--limit") {
      const raw = argv[i + 1];
      const n = raw !== undefined ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) throw new Error("--limit requires a positive page size");
      flags.limit = Math.trunc(n);
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

export function loadConfig(flags: CliFlags): WakeConfig {
  const agentId = env("FLAIR_AGENT_ID");
  if (!agentId) throw new Error("FLAIR_AGENT_ID is required");
  const dryRun = flags.dryRun;
  const cursorApiKey = env("CURSOR_API_KEY") ?? "";
  if (!dryRun && !cursorApiKey) throw new Error("CURSOR_API_KEY is required (or pass --dry-run)");
  const envTypeRaw = env("CURSOR_ENV_TYPE");
  const envType =
    envTypeRaw === "cloud" || envTypeRaw === "pool" || envTypeRaw === "machine" ? envTypeRaw : undefined;
  return {
    agentId,
    flairUrl: env("FLAIR_URL"),
    keyPath: env("FLAIR_KEY_PATH"),
    cursorApiKey,
    cursorApiBase: env("CURSOR_API_BASE") ?? "https://api.cursor.com",
    repoUrl: env("CURSOR_REPO_URL"),
    startingRef: env("CURSOR_STARTING_REF"),
    envName: env("CURSOR_ENV_NAME"),
    envType,
    autoCreatePr: env("CURSOR_AUTO_CREATE_PR") === "true" || env("CURSOR_AUTO_CREATE_PR") === "1",
    intervalSec: flags.intervalSec,
    dryRun,
    pageLimit: flags.limit,
  };
}

export const HELP = `cursor-flair-wake — drain this agent's OrgEventCatchup and wake a Cursor Cloud Agent

Usage:
  bun packages/cursor-wake-runner/src/cli.ts [--once] [--interval SECONDS] [--dry-run] [--limit N]

The runner is the wake trigger. Schedule it (cron / systemd / launchd) or leave
it looping with --interval. A Cursor Automation cron that shells this same
command also works; do not point an automation at "start a crew agent" directly
— that path has no idempotent agentId and can double-launch.

Identity:
  FLAIR_AGENT_ID     required. Own feed only — there is no --participant flag.
  FLAIR_URL          Flair HTTP origin (default http://localhost:19926)
  FLAIR_KEY_PATH     Ed25519 key (default ~/.flair/keys/<id>.key)

Cursor:
  CURSOR_API_KEY     required unless --dry-run
  CURSOR_API_BASE    default https://api.cursor.com
  CURSOR_REPO_URL    repo for launched agents (else parsed from the event pointer)
  CURSOR_STARTING_REF
  CURSOR_ENV_NAME    named Cursor environment (mutually exclusive with repo)
  CURSOR_ENV_TYPE    cloud | pool | machine
  CURSOR_AUTO_CREATE_PR  true to open a PR when the run completes

Idempotency:
  Each OrgEvent id maps to one Cursor agentId (bc-<uuid v5>). Re-POST is 409
  and is treated as already-handed-off, then acked. Redelivery cannot start a
  second agent.
`;
