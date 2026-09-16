/**
 * status.ts — extracted from src/cli.ts (flair#1636, epic #1618).
 *
 * Pure move, ZERO behavior change: `flair status` / `flair status --deep` (local probe, port auto-discovery, HealthDetail). Shared render helpers humanBytes()/relativeTime()/fetchHealthDetail() stay in cli.ts (other command modules bind them).
 * Shared cli-locals stay in cli.ts and are injected via bindCli() before
 * register(); this module never imports src/cli.ts. Top-level imports only
 * (no require(), #1653). Compiled strictly via tsconfig.check.src.json.
 */
import { Command } from "commander";
import { resolveAdminUser } from "../lib/auth-resolve.js";
import { opsApiBindFinding } from "../lib/ops-api-bind.js";
import * as render from "../render.js";
import { checkVersion, formatVersionNudge, FLAIR_PKG_NAME } from "../version-check.js";
import { resolveRegistryNotice } from "../lib/npm-registry.js";
import { hostname } from "node:os";
import { join } from "node:path";

export type StatusCli = {
  fetchHealthDetail: (...args: any[]) => any;
  humanBytes: (...args: any[]) => any;
  relativeTime: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
  sortSoulKeyEntries: (...args: any[]) => any;
  defaultDataDir: (...args: any[]) => any;
  readHarperConfig: (...args: any[]) => any;
  readPortFromConfig: (...args: any[]) => any;
  __pkgVersion: any;
};

let cli: StatusCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: StatusCli): void {
  cli = fns;
}

function fetchHealthDetail(...args: any[]): any {
  return cli.fetchHealthDetail(...args);
}

function humanBytes(...args: any[]): any {
  return cli.humanBytes(...args);
}

function relativeTime(...args: any[]): any {
  return cli.relativeTime(...args);
}

function resolveSigningAgentId(...args: any[]): any {
  return cli.resolveSigningAgentId(...args);
}

function sortSoulKeyEntries(...args: any[]): any {
  return cli.sortSoulKeyEntries(...args);
}

function defaultDataDir(...args: any[]): any {
  return cli.defaultDataDir(...args);
}

function readHarperConfig(...args: any[]): any {
  return cli.readHarperConfig(...args);
}

function readPortFromConfig(): number | null {
  return cli.readPortFromConfig();
}

/**
 * Local install-health warnings that `flair doctor` also checks (flair#852).
 *
 * The ops-API bind is read from the same harper-config.yaml doctor reads.
 * Only judged for a loopback target: the LOCAL install's config says nothing
 * about a remote instance, and warning about the wrong machine is its own lie.
 */
function localOpsApiWarnings(baseUrl: string): Array<{ level: string; message: string }> {
  const out: Array<{ level: string; message: string }> = [];
  if (!isLocalhostUrl(baseUrl)) return out;
  const finding = opsApiBindFinding(readHarperConfig(defaultDataDir()));
  if (finding?.allInterfaces) {
    // Name where the full explanation + fix live, matching the status warning
    // convention (docs/quickstart.md: a warning names the command to run).
    out.push({ level: "warn", message: `${finding.message} — run \`flair doctor\` for the fix` });
  }
  return out;
}

function federationPeerCountParts(peers: {
  connected?: number;
  disconnected?: number;
  revoked?: number;
  unknown?: number;
}): string[] {
  const connected = Number(peers?.connected ?? 0);
  const disconnected = Number(peers?.disconnected ?? 0);
  const revoked = Number(peers?.revoked ?? 0);
  const unknown = Number(peers?.unknown ?? 0);
  const parts = [
    render.wrap(connected > 0 ? render.c.green : render.c.dim, `${connected} connected`),
    render.wrap(disconnected > 0 ? render.c.yellow : render.c.dim, `${disconnected} down`),
    render.wrap(revoked > 0 ? render.c.red : render.c.dim, `${revoked} revoked`),
  ];
  if (unknown > 0) {
    parts.push(render.wrap(render.c.dim, `${unknown} unknown`));
  }
  return parts;
}


function oauthSummaryLines(o: any): string[] {
  const clients = Number(o?.clients ?? 0);
  const idps = Number(o?.idpConfigs ?? 0);
  const tokens = Number(o?.activeTokens ?? 0);
  return [
    "\nOAuth:",
    `  Clients:     ${clients}   IdPs: ${idps}   Active tokens: ${tokens}`,
  ];
}


function oauthDetailLines(o: any): string[] {
  const clients = Number(o?.clients ?? 0);
  const idps = Number(o?.idpConfigs ?? 0);
  const tokens = Number(o?.activeTokens ?? 0);
  const out: string[] = [
    "OAuth:",
    `  Clients:       ${clients}`,
    `  IdP configs:   ${idps}`,
    `  Active tokens: ${tokens}`,
  ];
  if (Array.isArray(o?.clientList) && o.clientList.length > 0) {
    out.push("", "  Clients:");
    for (const c of o.clientList) {
      const id = String(c?.id ?? "");
      const name = String(c?.name ?? "—");
      const registeredBy = String(c?.registeredBy ?? "—");
      const createdAt = String(c?.createdAt ?? "—");
      out.push(`    ${id}  ${name}  ${registeredBy}  ${createdAt}`);
    }
  }
  if (Array.isArray(o?.idpList) && o.idpList.length > 0) {
    out.push("", "  IdPs:");
    for (const i of o.idpList) {
      const id = String(i?.id ?? "");
      const name = String(i?.name ?? "—");
      const issuer = String(i?.issuer ?? "—");
      out.push(`    ${id}  ${name}  ${issuer}`);
    }
  }
  return out;
}

// Common localhost ports a running Flair daemon might be on. Used by
// discoverLocalFlairPort when the configured URL is unreachable, to detect
// config-vs-daemon port drift. Order is ad-hoc — first hit wins.
//
// 9926: original default (long-running early installs predate the bump)
// 19926: current default (DEFAULT_PORT)
// 19925: ops-anvil VM secondary

const LOCAL_FLAIR_PROBE_PORTS = [9926, 19926, 19925];


/**
 * The unreachable-path guidance for a localhost target, as printable lines.
 *
 * flair#1719: the old message asserted "Your config points at <resolved URL>"
 * without ever reading the config, and then told the user to "set port: N" in
 * a file that may already say exactly that — a remedy that cannot work. This
 * reads the per-user config and only names it when it actually disagrees with
 * the running daemon; when the config is already correct it points at the
 * command that reconciles the instance record instead of the file.
 *
 * Pure so the wording is pinned by a unit test (the daemon is not required).
 */
export function formatPortDriftGuidance(args: {
  baseUrl: string;
  discoveredPort: number | null;
  configuredPort: number | null;
}): string[] {
  const lines: string[] = [];
  if (args.discoveredPort == null) {
    if (args.configuredPort != null) {
      lines.push(`\n  ~/.flair/config.yaml records port ${args.configuredPort}, but nothing answered there.`);
    }
    lines.push(`\n  Run: flair start  or  flair doctor`);
    return lines;
  }

  const altUrl = `http://127.0.0.1:${args.discoveredPort}`;
  lines.push(`\n  ⚠ Found a Flair daemon listening on port ${args.discoveredPort} (URL: ${altUrl}).`);

  if (args.configuredPort === args.discoveredPort) {
    // The config already names the running port. The divergence is in the
    // instance's own record, not the operator's config — do not send them to
    // edit a file that is already right.
    lines.push(`    ~/.flair/config.yaml already records port ${args.configuredPort}; the resolved URL (${args.baseUrl}) is not that port.`);
    lines.push(`\n  Quick fix: FLAIR_URL=${altUrl} flair status`);
    lines.push(`  Permanent fix: flair doctor  (reconcile the instance's recorded port with the running daemon)`);
  } else if (args.configuredPort != null) {
    lines.push(`    ~/.flair/config.yaml records port ${args.configuredPort}; the daemon is on ${args.discoveredPort}.`);
    lines.push(`\n  Quick fix: FLAIR_URL=${altUrl} flair status`);
    lines.push(`  Permanent fix: edit ~/.flair/config.yaml to set port: ${args.discoveredPort}`);
    lines.push(`  Or: flair doctor`);
  } else {
    lines.push(`    No port is recorded in ~/.flair/config.yaml.`);
    lines.push(`\n  Quick fix: FLAIR_URL=${altUrl} flair status`);
    lines.push(`  Permanent fix: edit ~/.flair/config.yaml to set port: ${args.discoveredPort}`);
    lines.push(`  Or: flair doctor`);
  }
  return lines;
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // URL.hostname keeps brackets around IPv6 (e.g. "[::1]") so match both forms.
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]"
    );
  } catch { return false; }
}

/**
 * When a configured-localhost URL is unreachable, probe a small candidate-port
 * set to detect a daemon listening on a different port (config drift). Returns
 * the first responsive port, or null if none. Excludes the original port from
 * the probe set so we don't repeat the failed call.
 *
 * Runs sequentially with a 500ms timeout per probe — typical 3-port sweep
 * completes in <1.5s on a healthy box, faster on an unhealthy one.
 */

export async function discoverLocalFlairPort(originalUrl: string): Promise<number | null> {
  if (!isLocalhostUrl(originalUrl)) return null;
  let originalPort: number | null = null;
  try { originalPort = Number(new URL(originalUrl).port) || null; } catch { /* ignore */ }
  for (const port of LOCAL_FLAIR_PROBE_PORTS) {
    if (port === originalPort) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(500) });
      // Treat 401 (auth required) the same as 200 — the daemon is alive,
      // we just can't see /Health without admin auth. The point is to detect
      // "something is listening" not "we have full access".
      if (res.ok || res.status === 401) return port;
    } catch { /* port not listening, try next */ }
  }
  return null;
}


export function register(program: Command): void {
  const __pkgVersion = cli.__pkgVersion;


// Renders OAuth status lines from non-secret metadata. /HealthDetail never
// returns clientSecret — only counts and identifying fields (id, name,
// registeredBy, createdAt, issuer). Inputs are coerced to scalar primitives
// before formatting to keep the display values clearly separated from the
// source record.
/** Colored `N connected · N down · N revoked` (+ unknown when > 0). */



const statusCmd = program
  .command("status")
  .description("Show Flair instance status, memory stats, and agent info")
  .option("--port <port>", "Harper HTTP port")
  .option("--url <url>", "Flair base URL (overrides --port)")
  .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
  .option("--json", "Output as JSON")
  .option("--agent <id>", "Agent ID for authenticated detail (or set FLAIR_AGENT_ID)")
  .action(async (opts) => {
    const { agentId: statusAgentId, source: statusSource } = resolveSigningAgentId(opts, "status");
    const { healthy, baseUrl, healthData } = await fetchHealthDetail(opts, statusAgentId, statusSource);

    // Local ops-API bind (flair#852). `flair doctor` reads this from the same
    // harper-config.yaml; the two commands must not disagree. A bare ops port
    // is Harper's all-interfaces default, so reporting "all checks passing"
    // while it is exposed is a lying green.
    const localWarnings = localOpsApiWarnings(baseUrl);

    // When unreachable on a localhost URL, probe candidate ports to detect
    // config-vs-daemon port drift. Surface the actually-listening
    // port with a fix recipe — better UX than just "unreachable."
    let discoveredPort: number | null = null;
    if (!healthy && isLocalhostUrl(baseUrl)) {
      discoveredPort = await discoverLocalFlairPort(baseUrl);
    }

    // Version-behind check (flair#587) — offline-tolerant + cached, so this
    // never fails `status` when the registry is unreachable, and costs no
    // network round trip on the common up-to-date path. When a cached answer
    // would print a nudge it spends one short-timeout refetch so the printed
    // fact is current (flair#1341). Independent of Harper health; runs either way.
    const versionCheckResult = await checkVersion(__pkgVersion);
    const versionNudge = formatVersionNudge(versionCheckResult);
    // flair#1692: name the registry (and where it came from) on every status
    // check, so a redirected mirror is never silent — including when the
    // version answer came from cache and no network request was made.
    const registryNotice = await resolveRegistryNotice(FLAIR_PKG_NAME);

    if (opts.json) {
      const out: any = { healthy, url: baseUrl, flairVersion: __pkgVersion, ...healthData };
      if (localWarnings.length > 0) {
        out.warnings = [
          ...localWarnings,
          ...(Array.isArray(healthData?.warnings) ? healthData.warnings : []),
        ];
      }
      if (discoveredPort != null) out.discoveredPort = discoveredPort;
      if (versionCheckResult.latest) out.latestVersion = versionCheckResult.latest;
      if (registryNotice.line) out.registry = registryNotice.line;
      if (registryNotice.error) out.registryError = registryNotice.error;
      console.log(JSON.stringify(out, null, 2));
      if (!healthy) process.exit(1);
      return;
    }

    if (!healthy) {
      console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
      console.log(`  URL:  ${baseUrl}`);
      if (registryNotice.line) console.log(`  ${registryNotice.line}`);
      if (registryNotice.error) console.log(`  ⚠ ${registryNotice.error}`);
      if (discoveredPort != null) {
        for (const line of formatPortDriftGuidance({
          baseUrl,
          discoveredPort,
          configuredPort: readPortFromConfig(),
        })) {
          console.log(line);
        }
      } else {
        for (const line of formatPortDriftGuidance({
          baseUrl,
          discoveredPort: null,
          configuredPort: readPortFromConfig(),
        })) {
          console.log(line);
        }
      }
      if (versionNudge) {
        const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
        console.log(`\n  ${render.wrap(color, "⚠")} ${render.wrap(color, versionNudge.message)}`);
      }
      process.exit(1);
    }

    const uptimeSec = healthData?.uptimeSeconds;
    let uptimeStr = "";
    if (uptimeSec != null) {
      const d = Math.floor(uptimeSec / 86400);
      const h = Math.floor((uptimeSec % 86400) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      uptimeStr = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const pid = healthData?.pid ?? "";
    const agents = healthData?.agents;
    const memories = healthData?.memories;
    const warnings: Array<{ level: string; message: string }> = [
      ...localWarnings,
      ...(Array.isArray(healthData?.warnings) ? healthData.warnings : []),
    ];
    // Scope warnings to the filtered agent if --agent is set
    const scopedWarnings = opts.agent && healthData?.agents?.perAgent
      ? warnings.filter((w: any) => {
          // Hash-fallback warnings contain agent-specific counts
          if (w.message.includes("hash-fallback")) {
            const match = w.message.match(/\b(\d+)\/(\d+) \((\d+)%\)/);
            if (match) {
              const hashCount = parseInt(match[1]);
              const totalCount = parseInt(match[2]);
              const agentRow = healthData.agents.perAgent.find((r: any) => r.id === opts.agent);
              if (agentRow && agentRow.hashFallback === hashCount && agentRow.memoryCount === totalCount) {
                return true;
              }
              return false;
            }
          }
          // Mixed-model / outstanding stamp-migration warnings are fleet-wide; keep them
          if (w.message.includes("multiple embedding models")) return true;
          if (w.message.includes("embedding-stamp") || w.message.includes("duplicate detection is inactive")) return true;
          // Federation warnings are fleet-wide; keep them
          if (w.message.includes("federation")) return true;
          // REM warnings are fleet-wide; keep them
          if (w.message.includes("REM") || w.message.includes("nightly")) return true;
          // Ops-API bind is a host fact, not per-agent; keep it
          if (w.message.includes("Ops API bound")) return true;
          // Default: keep fleet-wide warnings
          return !w.message.includes(opts.agent);
        })
      : warnings;

    const hasWarn = scopedWarnings.some((w) => w.level === "warn");
    const headerIcon = hasWarn ? render.icons.warn : render.icons.ok;

    const versionStr = render.wrap(render.c.bold, `Flair v${__pkgVersion}`);
    const runStatus = `${headerIcon} ${render.wrap(render.c.green, "running")}`;
    const pidPart = pid ? render.wrap(render.c.dim, `PID ${pid}`) : "";
    const uptimePart = uptimeStr ? render.wrap(render.c.dim, `uptime ${uptimeStr}`) : "";
    const metaParts = [pidPart, uptimePart].filter(Boolean).join(render.wrap(render.c.dim, " · "));
    console.log(`${versionStr} ${render.wrap(render.c.dim, "—")} ${runStatus}${metaParts ? `  ${metaParts}` : ""}`);
    console.log(render.kv("URL", baseUrl));
    if (registryNotice.line) console.log(render.kv("Registry", registryNotice.line.replace(/^registry:\s*/, "")));
    if (registryNotice.error) console.log(`  ${render.icons.warn} ${render.wrap(render.c.yellow, registryNotice.error)}`);

    if (versionNudge) {
      const color = versionNudge.severity === "red" ? render.c.red : render.c.yellow;
      console.log(`\n  ${render.wrap(color, "⚠")} ${render.wrap(color, versionNudge.message)}`);
    }

    if (scopedWarnings.length > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Warnings")}  ${render.wrap(render.c.dim, `(${scopedWarnings.length})`)}`);
      for (const w of scopedWarnings) {
        const icon = w.level === "warn" ? render.icons.warn : render.icons.info;
        console.log(`  ${icon} ${w.message}`);
      }
    }

    if (memories) {
      console.log(`\n${render.wrap(render.c.bold, "Memory")}`);
      const embStr = memories.withEmbeddings > 0 ? `${memories.withEmbeddings} embedded` : "";
      const hashStr = memories.hashFallback > 0 ? `${memories.hashFallback} hash` : "";
      const detail = [embStr, hashStr].filter(Boolean).join(", ");
      console.log(render.kv("Total", `${render.wrap(render.c.bold, String(memories.total))}${detail ? ` ${render.wrap(render.c.dim, `(${detail})`)}` : ""}`));
      if (memories.modelCounts && typeof memories.modelCounts === "object") {
        const entries = Object.entries(memories.modelCounts as Record<string, number>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length > 0) {
          const formatted = entries.map(([k, n]: [string, number]) => `${render.wrap(render.c.cyan, k)}:${n}`).join(render.wrap(render.c.dim, ", "));
          console.log(render.kv("Embeddings", formatted));
        }
      }
      if (memories.byDurability) {
        const d = memories.byDurability;
        const parts = [
          `${render.wrap(render.c.magenta, "permanent")}:${d.permanent ?? 0}`,
          `${render.wrap(render.c.blue, "persistent")}:${d.persistent ?? 0}`,
          `${render.wrap(render.c.cyan, "standard")}:${d.standard ?? 0}`,
          `${render.wrap(render.c.gray, "ephemeral")}:${d.ephemeral ?? 0}`,
        ];
        console.log(render.kv("Durability", parts.join(render.wrap(render.c.dim, " · "))));
      }
      if (typeof memories.archived === "number") console.log(render.kv("Archived", String(memories.archived)));
      if (typeof memories.expired === "number" && memories.expired > 0) {
        console.log(render.kv("Expired", `${render.wrap(render.c.yellow, String(memories.expired))}`));
      }
      if (healthData?.lastWrite) console.log(render.kv("Last write", render.relativeTime(healthData.lastWrite)));
    }

    if (agents && agents.count > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Agents")}`);
      const nameStr = agents.names?.length > 0 ? ` ${render.wrap(render.c.dim, "—")} ${agents.names.join(render.wrap(render.c.dim, ", "))}` : "";
      console.log(render.kv("Total", `${render.wrap(render.c.bold, String(agents.count))}${nameStr}`));
      if (agents.count > 1 && Array.isArray(agents.perAgent) && agents.perAgent.length > 0) {
        const hasDeep = agents.perAgent.some(
          (r: any) => typeof r.hashFallback === "number" || typeof r.writes24h === "number",
        );
        const cols: render.TableColumn[] = hasDeep
          ? [
              { label: "id", key: "id" },
              { label: "memories", key: "memoryCount", align: "right" },
              { label: "hash_fb", key: "hashFallback", align: "right", format: (v) => (typeof v === "number" ? String(v) : "—") },
              { label: "24h", key: "writes24h", align: "right", format: (v) => (typeof v === "number" ? String(v) : "—") },
              { label: "last_write", key: "lastWriteAt", format: (v) => render.relativeTime(v as string | null) },
            ]
          : [
              { label: "id", key: "id" },
              { label: "memories", key: "memoryCount", align: "right" },
              { label: "last_write", key: "lastWriteAt", format: (v) => render.relativeTime(v as string | null) },
            ];
        console.log(render.table(cols, agents.perAgent as Array<Record<string, unknown>>));
      }
    }

    if (healthData?.relationships) {
      const r = healthData.relationships;
      console.log(`\n${render.wrap(render.c.bold, "Relationships")}`);
      console.log(render.kv("Total", `${r.total}  ${render.wrap(render.c.dim, `(${r.active} active)`)}`));
    }

    if (healthData?.soul && healthData.soul.total > 0) {
      const s = healthData.soul;
      console.log(`\n${render.wrap(render.c.bold, "Soul")}`);
      const entries = sortSoulKeyEntries(s.byKey ?? {});
      const parts = entries.map(([k, n]: [string, number]) => `${render.wrap(render.c.cyan, k)}:${n}`);
      const suffix = parts.length > 0
        ? ` ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`
        : "";
      console.log(render.kv("Entries", `${render.wrap(render.c.bold, String(s.total))}${suffix}`));
    } else if (typeof healthData?.soulEntries === "number" && healthData.soulEntries > 0) {
      console.log(`\n${render.wrap(render.c.bold, "Soul")}`);
      console.log(render.kv("Entries", String(healthData.soulEntries)));
    }

    if (healthData?.rem) {
      const r = healthData.rem;
      console.log(`\n${render.wrap(render.c.bold, "REM")}`);
      if (r.lastLightAt) console.log(render.kv("Last light", render.relativeTime(r.lastLightAt)));
      if (r.lastRapidAt) console.log(render.kv("Last rapid", render.relativeTime(r.lastRapidAt)));
      if (r.lastRestorativeAt) console.log(render.kv("Last restorative", render.relativeTime(r.lastRestorativeAt)));
      const nightlyTxt = r.nightlyEnabled === true
        ? render.wrap(render.c.green, "enabled")
        : r.nightlyEnabled === false
          ? render.wrap(render.c.dim, "disabled")
          : render.wrap(render.c.dim, "unknown");
      console.log(render.kv("Nightly", nightlyTxt));
      if (r.nightlyEnabled && r.lastNightlyAt) console.log(render.kv("Last nightly", render.relativeTime(r.lastNightlyAt)));
      if (typeof r.pendingCandidates === "number" && r.pendingCandidates > 0) {
        console.log(render.kv("Pending candidates", render.wrap(render.c.yellow, String(r.pendingCandidates))));
      }
    }

    if (healthData?.federation) {
      const f = healthData.federation;
      console.log(`\n${render.wrap(render.c.bold, "Federation")}`);
      if (f.instance) {
        const statusColor = f.instance.status === "active" ? render.c.green : render.c.yellow;
        console.log(render.kv("Instance", `${f.instance.id}  ${render.wrap(render.c.dim, "(")}${f.instance.role ?? "—"}${render.wrap(render.c.dim, ", ")}${render.wrap(statusColor, f.instance.status ?? "—")}${render.wrap(render.c.dim, ")")}`));
      }
      if (f.peers) {
        const parts = federationPeerCountParts(f.peers);
        console.log(render.kv("Peers", `${render.wrap(render.c.bold, String(f.peers.total))} ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`));
      }
      if (f.pendingTokens > 0) console.log(render.kv("Pairing", `${render.wrap(render.c.yellow, String(f.pendingTokens))} unconsumed token(s)`));
    } else {
      console.log(`\n${render.wrap(render.c.bold, "Federation")}  ${render.wrap(render.c.dim, "not configured")}`);
    }

    if (healthData?.oauth) {
      const lines = oauthSummaryLines(healthData.oauth);
      // Tweak the "OAuth:" header to bold; downstream lines are aligned k/v which already look fine
      for (const line of lines) {
        if (line.trim() === "OAuth:") console.log(`\n${render.wrap(render.c.bold, "OAuth")}`);
        else console.log(line);
      }
    }

    if (healthData?.bridges) {
      const b = healthData.bridges;
      console.log(`\n${render.wrap(render.c.bold, "Bridges")}`);
      if (Array.isArray(b.installed) && b.installed.length > 0) console.log(render.kv("Installed", b.installed.join(render.wrap(render.c.dim, ", "))));
      if (b.lastImport) console.log(render.kv("Last import", render.relativeTime(b.lastImport)));
      if (b.lastExport) console.log(render.kv("Last export", render.relativeTime(b.lastExport)));
    } else {
      console.log(`\n${render.wrap(render.c.bold, "Bridges")}  ${render.wrap(render.c.dim, "none installed")}`);
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log(`\n${render.wrap(render.c.bold, "Disk")}`);
      console.log(render.kv("Data", `${render.wrap(render.c.dim, d.dataDir)} ${render.wrap(render.c.dim, "—")} ${render.wrap(render.c.bold, render.humanBytes(d.dataBytes ?? 0))}`));
      console.log(render.kv("Snapshots", `${render.wrap(render.c.dim, d.snapshotDir)} ${render.wrap(render.c.dim, "—")} ${render.wrap(render.c.bold, render.humanBytes(d.snapshotBytes ?? 0))}`));
    }

    console.log("");
    if (scopedWarnings.length > 0) {
      console.log(`  ${render.icons.warn} ${render.wrap(render.c.yellow, `${scopedWarnings.length} warning${scopedWarnings.length === 1 ? "" : "s"}`)}`);
    } else {
      console.log(`  ${render.icons.ok} ${render.wrap(render.c.green, "all checks passing")}`);
    }
  });


statusCmd
  .command("rem")
  .description("Show REM (memory hygiene) subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, rem: healthData?.rem ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const r = healthData?.rem;
    if (!r) {
      console.log(`${render.wrap(render.c.bold, "REM")}  ${render.wrap(render.c.dim, "not configured (no log entries or platform timers found)")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "REM"));
    console.log(render.kv("Last light", render.relativeTime(r.lastLightAt), 18));
    console.log(render.kv("Last rapid", render.relativeTime(r.lastRapidAt), 18));
    console.log(render.kv("Last restorative", render.relativeTime(r.lastRestorativeAt), 18));
    const nightlyTxt = r.nightlyEnabled === true
      ? render.wrap(render.c.green, "enabled")
      : r.nightlyEnabled === false
        ? render.wrap(render.c.dim, "disabled")
        : render.wrap(render.c.dim, "unknown");
    console.log(render.kv("Nightly", nightlyTxt, 18));
    if (r.lastNightlyAt) {
      console.log(render.kv("Last nightly", `${render.relativeTime(r.lastNightlyAt)} ${render.wrap(render.c.dim, `(${r.lastNightlyAt})`)}`, 18));
    }
    if (typeof r.pendingCandidates === "number") {
      const pendingColor = r.pendingCandidates > 0 ? render.c.yellow : render.c.dim;
      console.log(render.kv("Pending candidates", render.wrap(pendingColor, String(r.pendingCandidates)), 18));
    } else {
      console.log(render.kv("Pending candidates", render.wrap(render.c.dim, "— (schema not available)"), 18));
    }
  });


statusCmd
  .command("federation")
  .description("Show federation subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, federation: healthData?.federation ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const f = healthData?.federation;
    if (!f) {
      console.log(`${render.wrap(render.c.bold, "Federation")}  ${render.wrap(render.c.dim, "not configured")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "Federation"));
    if (f.instance) {
      const statusColor = f.instance.status === "active" ? render.c.green : render.c.yellow;
      console.log(render.kv("Instance", `${f.instance.id}  ${render.wrap(render.c.dim, "(")}${f.instance.role ?? "—"}${render.wrap(render.c.dim, ", ")}${render.wrap(statusColor, f.instance.status ?? "—")}${render.wrap(render.c.dim, ")")}`));
    } else {
      console.log(render.kv("Instance", render.wrap(render.c.dim, "—")));
    }
    if (f.peers) {
      const parts = federationPeerCountParts(f.peers);
      console.log(render.kv("Peers", `${render.wrap(render.c.bold, String(f.peers.total))} ${render.wrap(render.c.dim, "—")} ${parts.join(render.wrap(render.c.dim, " · "))}`));
    }
    if (typeof f.pendingTokens === "number" && f.pendingTokens > 0) {
      console.log(render.kv("Pairing", `${render.wrap(render.c.yellow, String(f.pendingTokens))} unconsumed token(s)`));
    }
    if (Array.isArray(f.peerList) && f.peerList.length > 0) {
      console.log();
      const cols: render.TableColumn[] = [
        { label: "peer", key: "id" },
        { label: "role", key: "role", format: (v) => String(v ?? "—") },
        {
          label: "status",
          key: "status",
          format: (v) => {
            const s = String(v ?? "—");
            const color = s === "paired" || s === "connected" ? render.c.green : s === "revoked" ? render.c.red : render.c.yellow;
            return render.wrap(color, s);
          },
        },
        {
          label: "liveness",
          key: "liveness",
          format: (v) => {
            const s = String(v ?? "—");
            const color = s === "connected" ? render.c.green : s === "disconnected" ? render.c.yellow : s === "revoked" ? render.c.red : render.c.dim;
            return render.wrap(color, s);
          },
        },
        {
          label: "last_sync",
          key: "lastSyncAt",
          format: (v) => {
            const iso = v as string | null;
            if (!iso) return render.wrap(render.c.dim, "never");
            return `${render.relativeTime(iso)} ${render.wrap(render.c.dim, `(${iso})`)}`;
          },
        },
      ];
      console.log(render.table(cols, f.peerList as Array<Record<string, unknown>>));
    }
  });


statusCmd
  .command("auth")
  .description("Show OAuth / IdP subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, oauth: healthData?.oauth ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const o = healthData?.oauth;
    if (!o) {
      console.log(`${render.wrap(render.c.bold, "OAuth")}  ${render.wrap(render.c.dim, "not configured")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "OAuth"));
    console.log(render.kv("Clients", render.wrap(render.c.bold, String(Number(o?.clients ?? 0)))));
    console.log(render.kv("IdP configs", String(Number(o?.idpConfigs ?? 0))));
    const tokenColor = Number(o?.activeTokens ?? 0) > 0 ? render.c.green : render.c.dim;
    console.log(render.kv("Active tokens", render.wrap(tokenColor, String(Number(o?.activeTokens ?? 0)))));
    if (Array.isArray(o?.clientList) && o.clientList.length > 0) {
      console.log(`\n  ${render.wrap(render.c.dim, "Clients")}`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id" },
        { label: "name", key: "name", format: (v) => String(v ?? "—") },
        { label: "registered_by", key: "registeredBy", format: (v) => String(v ?? "—") },
        { label: "created_at", key: "createdAt", format: (v) => String(v ?? "—") },
      ];
      console.log(render.table(cols, o.clientList as Array<Record<string, unknown>>));
    }
    if (Array.isArray(o?.idpList) && o.idpList.length > 0) {
      console.log(`\n  ${render.wrap(render.c.dim, "IdPs")}`);
      const cols: render.TableColumn[] = [
        { label: "id", key: "id" },
        { label: "name", key: "name", format: (v) => String(v ?? "—") },
        { label: "issuer", key: "issuer", format: (v) => String(v ?? "—") },
      ];
      console.log(render.table(cols, o.idpList as Array<Record<string, unknown>>));
    }
  });


statusCmd
  .command("bridges")
  .description("Show memory bridges subsystem status")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, healthData } = await fetchHealthDetail(opts);
    const mode = render.resolveOutputMode(opts);
    if (mode === "json") {
      console.log(render.asJSON({ healthy, bridges: healthData?.bridges ?? null }));
      if (!healthy) process.exit(1);
      return;
    }
    if (!healthy) {
      console.log(`${render.icons.error} ${render.wrap(render.c.red, "unreachable")}`);
      process.exit(1);
    }
    const b = healthData?.bridges;
    if (!b) {
      console.log(`${render.wrap(render.c.bold, "Bridges")}  ${render.wrap(render.c.dim, "none installed (no flair-bridge-* packages found)")}`);
      return;
    }
    console.log(render.wrap(render.c.bold, "Bridges"));
    if (Array.isArray(b.installed) && b.installed.length > 0) {
      console.log(render.kv("Installed", b.installed.join(render.wrap(render.c.dim, ", "))));
    }
    if (b.lastImport) console.log(render.kv("Last import", render.relativeTime(b.lastImport)));
    if (b.lastExport) console.log(render.kv("Last export", render.relativeTime(b.lastExport)));
  });

// ─── flair status --deep ──────────────────────────────────────────────────────
//
// Deeper observability than the default `flair status` summary — full
// per-section detail with no condensing. Optional --bootstrap measures
// cold-start context bytes per agent (slow; calls /MemoryBootstrap once per
// agent, admin-auth required).
//
// Addresses ops-yph: Nathan's 2026-04-22 ask for "how much storage does my
// memory take, how much context are bootstraps pulling, what's the real usage
// pattern" — questions the default `flair status` summarizes but doesn't
// surface in full. Agents should be able to self-audit via this too.


statusCmd
  .command("deep")
  .description("Verbose status + optional bootstrap context size per agent (ops-yph)")
  .option("--bootstrap", "Also measure bootstrap context bytes per agent (slow; admin auth required)")
  .option("--max-tokens <n>", "Bootstrap maxTokens cap when --bootstrap is set", "4000")
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const { healthy, baseUrl, healthData } = await fetchHealthDetail(opts);

    // Same local install-health facts the plain `status` renders, so `--deep`
    // cannot end on "✅ no warnings" while the ops API is exposed (flair#852).
    const localWarnings = localOpsApiWarnings(baseUrl);

    if (!healthy) {
      if (opts.json) {
        console.log(JSON.stringify({ healthy: false, url: baseUrl, error: "unreachable" }, null, 2));
      } else {
        console.log(`Flair v${__pkgVersion} — 🔴 unreachable`);
        console.log(`  URL:  ${baseUrl}`);
        console.log(`\n  Run: flair start  or  flair doctor`);
      }
      process.exit(1);
    }

    // Optional: per-agent bootstrap context bytes. Calls /MemoryBootstrap with
    // admin auth (so we can measure on behalf of any agent without holding
    // their keys). 15s timeout per call — bootstrap can be expensive on cold
    // caches or large memory sets.
    const agentList: string[] =
      (Array.isArray(healthData?.agents?.names) && healthData.agents.names.length > 0
        ? healthData.agents.names
        : Array.isArray(healthData?.agents?.perAgent)
          ? healthData.agents.perAgent.map((r: any) => r.id).filter(Boolean)
          : []) as string[];
    const bootstrapBytes: Record<string, { bytes: number; tokenEstimate?: number; memoriesIncluded?: number; error?: string }> = {};
    if (opts.bootstrap && agentList.length > 0) {
      const adminPass = process.env.HDB_ADMIN_PASSWORD || process.env.FLAIR_ADMIN_PASS;
      if (!adminPass) {
        if (!opts.json) {
          console.log("⚠ --bootstrap requires HDB_ADMIN_PASSWORD or FLAIR_ADMIN_PASS env var");
        }
      } else {
        const auth = `Basic ${Buffer.from(`${resolveAdminUser(undefined)}:${adminPass}`).toString("base64")}`;
        const maxTokens = Number.parseInt(String(opts.maxTokens ?? "4000"), 10);
        for (const agentId of agentList) {
          try {
            const res = await fetch(`${baseUrl}/BootstrapMemories`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: auth },
              body: JSON.stringify({ agentId, maxTokens }),
              signal: AbortSignal.timeout(15000),
            });
            const text = await res.text();
            const bytes = Buffer.byteLength(text, "utf8");
            let tokenEstimate: number | undefined;
            let memoriesIncluded: number | undefined;
            try {
              const json = JSON.parse(text);
              tokenEstimate = typeof json.tokenEstimate === "number" ? json.tokenEstimate : undefined;
              memoriesIncluded = typeof json.memoriesIncluded === "number" ? json.memoriesIncluded : undefined;
            } catch { /* response wasn't JSON; bytes still valid */ }
            if (!res.ok) {
              bootstrapBytes[agentId] = { bytes, error: `HTTP ${res.status}` };
            } else {
              bootstrapBytes[agentId] = { bytes, tokenEstimate, memoriesIncluded };
            }
          } catch (e: any) {
            bootstrapBytes[agentId] = { bytes: 0, error: e?.message ?? String(e) };
          }
        }
      }
    }

    if (opts.json) {
      const out: Record<string, any> = { healthy, url: baseUrl, flairVersion: __pkgVersion, ...healthData };
      if (localWarnings.length > 0) {
        out.warnings = [
          ...localWarnings,
          ...(Array.isArray(healthData?.warnings) ? healthData.warnings : []),
        ];
      }
      if (opts.bootstrap) out.bootstrapBytes = bootstrapBytes;
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // Human-readable verbose render.
    const uptimeSec = healthData?.uptimeSeconds;
    let uptimeStr = "";
    if (uptimeSec != null) {
      const d = Math.floor(uptimeSec / 86400);
      const h = Math.floor((uptimeSec % 86400) / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      uptimeStr = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    const pid = healthData?.pid ?? "?";

    console.log(`Flair v${__pkgVersion} — running (PID ${pid}${uptimeStr ? `, uptime ${uptimeStr}` : ""})`);
    console.log(`URL: ${baseUrl}`);

    const memories = healthData?.memories;
    if (memories) {
      console.log("\n═══ Memory ═══════════════════════════════════════");
      console.log(`Total:        ${memories.total}`);
      console.log(`Breakdown:    ${memories.withEmbeddings ?? 0} embedded, ${memories.hashFallback ?? 0} hash-fallback`);
      if (memories.modelCounts && memories.total > 0) {
        const entries = Object.entries(memories.modelCounts as Record<string, number>)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]);
        for (const [k, n] of entries) {
          const pct = ((n / memories.total) * 100).toFixed(1);
          console.log(`  ${k.padEnd(28)} ${String(n).padStart(6)}  (${pct}%)`);
        }
      }
      if (memories.byDurability) {
        const d = memories.byDurability;
        console.log(`Durability:   ${d.permanent ?? 0} permanent / ${d.persistent ?? 0} persistent / ${d.standard ?? 0} standard / ${d.ephemeral ?? 0} ephemeral`);
      }
      console.log(`Archived:     ${memories.archived ?? 0}`);
      console.log(`Expired:      ${memories.expired ?? 0}`);
      if (healthData?.lastWrite) console.log(`Last write:   ${relativeTime(healthData.lastWrite)} (${healthData.lastWrite})`);
    }

    const agents = healthData?.agents;
    if (agents && agents.count > 0) {
      console.log("\n═══ Agents ═══════════════════════════════════════");
      console.log(`Total:        ${agents.count}`);
      if (Array.isArray(agents.names) && agents.names.length > 0) {
        console.log(`Names:        ${agents.names.join(", ")}`);
      }
      if (Array.isArray(agents.perAgent) && agents.perAgent.length > 0) {
        const idW = Math.max(2, ...agents.perAgent.map((r: any) => (r.id ?? "").length));
        console.log(`\n  ${"id".padEnd(idW)}  memories  hash_fb  24h  last_write`);
        for (const r of agents.perAgent) {
          const fb = typeof r.hashFallback === "number" ? String(r.hashFallback) : "—";
          const w24 = typeof r.writes24h === "number" ? String(r.writes24h) : "—";
          console.log(
            `  ${(r.id ?? "").padEnd(idW)}  ${String(r.memoryCount).padStart(8)}  ${fb.padStart(7)}  ${w24.padStart(3)}  ${relativeTime(r.lastWriteAt)}`,
          );
        }
      }
    }

    // Bootstrap context section — always printed so users see how to opt in.
    console.log("\n═══ Bootstrap context ═══════════════════════════");
    if (!opts.bootstrap) {
      console.log("  (not measured — pass --bootstrap to fetch per-agent context bytes)");
    } else if (Object.keys(bootstrapBytes).length === 0) {
      console.log("  (no agents found, or admin pass missing — see HDB_ADMIN_PASSWORD)");
    } else {
      const idW = Math.max(5, ...Object.keys(bootstrapBytes).map((id) => id.length));
      console.log(`  ${"agent".padEnd(idW)}  ${"bytes".padStart(9)}  ${"~tokens".padStart(7)}  ${"mems".padStart(4)}  status`);
      // Sort by bytes desc so heaviest bootstraps surface first.
      const sortedEntries = Object.entries(bootstrapBytes).sort(
        (a, b) => (b[1].bytes ?? 0) - (a[1].bytes ?? 0),
      );
      for (const [agentId, info] of sortedEntries) {
        const bytesStr = info.error ? "error" : humanBytes(info.bytes);
        const tok = info.tokenEstimate != null ? String(info.tokenEstimate) : "—";
        const mems = info.memoriesIncluded != null ? String(info.memoriesIncluded) : "—";
        const status = info.error ? info.error.slice(0, 40) : "ok";
        console.log(`  ${agentId.padEnd(idW)}  ${bytesStr.padStart(9)}  ${tok.padStart(7)}  ${mems.padStart(4)}  ${status}`);
      }
    }

    if (healthData?.relationships) {
      const r = healthData.relationships;
      console.log("\n═══ Relationships ═══════════════════════════════");
      console.log(`Total:        ${r.total} (${r.active} active)`);
    }

    if (healthData?.soul && healthData.soul.total > 0) {
      const s = healthData.soul;
      console.log("\n═══ Soul ═════════════════════════════════════════");
      console.log(`Total:        ${s.total} entries`);
      const entries = sortSoulKeyEntries(s.byKey ?? {});
      if (entries.length > 0) {
        console.log(`Keys:         ${entries.map(([k, n]: [string, number]) => `${n} ${k}`).join(" / ")}`);
      }
    } else if (typeof healthData?.soulEntries === "number" && healthData.soulEntries > 0) {
      console.log("\n═══ Soul ═════════════════════════════════════════");
      console.log(`Total:        ${healthData.soulEntries} entries`);
    }

    if (healthData?.rem) {
      const r = healthData.rem;
      console.log("\n═══ REM ══════════════════════════════════════════");
      console.log(`Last light:        ${relativeTime(r.lastLightAt)}`);
      console.log(`Last rapid:        ${relativeTime(r.lastRapidAt)}`);
      console.log(`Last restorative:  ${relativeTime(r.lastRestorativeAt)}`);
      const nightly = r.nightlyEnabled === true ? "enabled" : r.nightlyEnabled === false ? "disabled" : "unknown";
      console.log(`Nightly:           ${nightly}`);
      if (r.lastNightlyAt) console.log(`Last nightly:      ${relativeTime(r.lastNightlyAt)} (${r.lastNightlyAt})`);
      if (typeof r.pendingCandidates === "number") console.log(`Pending candidates: ${r.pendingCandidates}`);
    }

    if (healthData?.federation) {
      const f = healthData.federation;
      console.log("\n═══ Federation ═══════════════════════════════════");
      if (f.instance) console.log(`Instance:     ${f.instance.id} (${f.instance.role ?? "—"}, ${f.instance.status ?? "—"})`);
      if (f.peers) {
        const unknown = Number(f.peers.unknown ?? 0);
        const unknownBit = unknown > 0 ? `, ${unknown} unknown` : "";
        console.log(`Peers:        ${f.peers.total} total (${f.peers.connected} connected, ${f.peers.disconnected} down, ${f.peers.revoked} revoked${unknownBit})`);
      }
      if (typeof f.pendingTokens === "number" && f.pendingTokens > 0) console.log(`Pairing:      ${f.pendingTokens} unconsumed token(s)`);
      if (Array.isArray(f.peerList) && f.peerList.length > 0) {
        const idW = Math.max(4, ...f.peerList.map((p: any) => (p.id ?? "").length));
        console.log(`\n  ${"peer".padEnd(idW)}  ${"role".padEnd(5)}  ${"status".padEnd(13)}  ${"liveness".padEnd(13)}  last_sync`);
        for (const p of f.peerList) {
          console.log(`  ${(p.id ?? "").padEnd(idW)}  ${(p.role ?? "—").padEnd(5)}  ${(p.status ?? "—").padEnd(13)}  ${(p.liveness ?? "—").padEnd(13)}  ${p.lastSyncAt ? `${relativeTime(p.lastSyncAt)} (${p.lastSyncAt})` : "never"}`);
        }
      }
    } else {
      console.log("\n═══ Federation ═══════════════════════════════════");
      console.log("  not configured");
    }

    if (healthData?.oauth) {
      const o = healthData.oauth;
      console.log("\n═══ OAuth / IdP ══════════════════════════════════");
      console.log(`Clients:       ${o.clients}`);
      console.log(`IdP configs:   ${o.idpConfigs}`);
      console.log(`Active tokens: ${o.activeTokens}`);
      if (Array.isArray(o.clientList) && o.clientList.length > 0) {
        console.log(`\n  Clients:`);
        for (const c of o.clientList) {
          console.log(`    ${c.id}  ${c.name ?? "—"}  ${c.registeredBy ?? "—"}  ${c.createdAt ?? "—"}`);
        }
      }
    }

    if (healthData?.bridges) {
      const b = healthData.bridges;
      console.log("\n═══ Bridges ══════════════════════════════════════");
      if (Array.isArray(b.installed) && b.installed.length > 0) console.log(`Installed:    ${b.installed.join(", ")}`);
      if (b.lastImport) console.log(`Last import:  ${relativeTime(b.lastImport)}`);
      if (b.lastExport) console.log(`Last export:  ${relativeTime(b.lastExport)}`);
    }

    if (healthData?.disk) {
      const d = healthData.disk;
      console.log("\n═══ Disk ═════════════════════════════════════════");
      console.log(`Data:         ${d.dataDir} — ${humanBytes(d.dataBytes ?? 0)}`);
      console.log(`Snapshots:    ${d.snapshotDir} — ${humanBytes(d.snapshotBytes ?? 0)}`);
      console.log(`Total:        ${humanBytes((d.dataBytes ?? 0) + (d.snapshotBytes ?? 0))}`);
    }

    const warnings: Array<{ level: string; message: string }> = [
      ...localWarnings,
      ...(Array.isArray(healthData?.warnings) ? healthData.warnings : []),
    ];
    if (warnings.length > 0) {
      console.log("\n═══ Warnings ═════════════════════════════════════");
      for (const w of warnings) console.log(`  ${w.level === "warn" ? "⚠" : "ℹ"} ${w.message}`);
    } else {
      console.log("\n✅ no warnings");
    }
  });

}
