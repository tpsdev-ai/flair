/**
 * bridge.ts — `flair bridge` command group (flair#1628 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration (list / import / export / test / scaffold /
 * roundtrip) and its action handlers, plus the group-specific error formatter
 * and printer (`formatBridgeErrorLines`, `printBridgeError`). All bridge runtime logic
 * still lives under src/bridges/. Two shared cli.ts-local helpers
 * (`api`, `resolveHttpPort`) are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import * as render from "../render.js";
import { resolveKeyPath, buildEd25519Auth, readSecretFileSecure, requestTarget, requestUrl } from "../lib/auth-resolve.js";
import type { BridgeOptionSpec } from "../bridges/types.js";
import { encodeRecordId } from "../lib/record-id-path.js";

export type BridgeCli = {
  api: (method: string, path: string, body?: any, options?: any) => Promise<any>;
  resolveHttpPort: (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create") => number;
};

let cli: BridgeCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: BridgeCli): void {
  cli = fns;
}

const api = (method: string, path: string, body?: any, options?: any): Promise<any> =>
  cli.api(method, path, body, options);

const resolveHttpPort = (opts: { port?: string | number; dataDir?: string }, mode?: "address" | "create"): number =>
  cli.resolveHttpPort(opts, mode);

function redactBridgeSecret(value: string, secret: string): string {
  if (!secret) return value;
  const forms = new Set<string>();
  for (let form = secret; form.length <= value.length && !forms.has(form); form = JSON.stringify(form).slice(1, -1)) {
    forms.add(form);
  }
  try {
    forms.add(encodeURIComponent(secret));
  } catch {}
  if (!forms.size) return value;
  const pattern = [...forms].sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return value.replace(new RegExp(pattern, "g"), "[REDACTED]");
}

/** Serialize first, then redact so object keys and values share one boundary. */
export function serializeBridgeLogLine(event: unknown, secret: string): string {
  return redactBridgeSecret(JSON.stringify(event), secret);
}

type TrustErrorDetail = {
  bridge?: string;
  got?: string;
  hint?: string;
  context?: Record<string, string>;
};

function formatTrustErrorLines(detail: TrustErrorDetail, secret: string): string[] {
  const lines: string[] = [];
  const write = (line = ""): void => { lines.push(line); };
  const name = detail.bridge ?? "(unknown)";
  const ctx = detail.context ?? {};
  const reapprove = `  flair bridge allow ${name}`;
  const bar = "─".repeat(60);

  const header = (title: string) => {
    write();
    write(`⚠ ${title} — ${name}`);
    write(bar);
  };

  const footer = (label: string) => {
    write();
    write(`${label}:`);
    write(reapprove);
    write();
  };

  switch (detail.got) {
    case "not-allowed":
      header("Approval required");
      write("This bridge is an npm code plugin — it runs arbitrary JavaScript.");
      write("First-use approval is required before Flair will execute it.");
      footer("Approve it with");
      break;

    case "path-mismatch":
      header("Trust check failed: package location changed");
      write("A different package with the same name was discovered. This is how");
      write("local squatting attacks present — a planted `node_modules/flair-bridge-*`");
      write("in an unrelated project tree.");
      write();
      write(`  approved: ${ctx.approvedPath ?? "(unknown)"}`);
      write(`            version ${ctx.approvedVersion ?? "?"} at ${ctx.approvedAt ?? "?"}`);
      write(`  now:      ${ctx.observedPath ?? "(unknown)"}`);
      footer("If the new location is intentional, re-approve");
      break;

    case "digest-mismatch":
      header("Trust check failed: package contents changed");
      write("The package.json at the approved location has changed since you");
      write("approved this bridge. This fires on every upgrade — it's a trust");
      write("event, not an error. If the update is intentional, re-approve.");
      write();
      write(`  location:          ${ctx.packagePath ?? "(unknown)"}`);
      write(`  approved version:  ${ctx.approvedVersion ?? "?"}   (at ${ctx.approvedAt ?? "?"})`);
      write(`  approved digest:   sha256:${(ctx.approvedDigest ?? "").slice(0, 16)}…`);
      write(`  observed digest:   sha256:${(ctx.observedDigest ?? "").slice(0, 16)}…`);
      footer("Re-approve");
      break;

    case "entry-incomplete":
      header("Trust check failed: approval record is incomplete");
      write("The allow-list entry for this bridge is missing a location or digest.");
      write("This usually means the record was created by a pre-fix Flair version");
      write("(0.6.0 / 0.6.1) that only stored the name. Re-approve to upgrade.");
      footer("Re-approve");
      break;

    case "package-missing":
      header("Trust check failed: approved package missing on disk");
      write("The package location recorded at allow-time is no longer readable.");
      write();
      write(`  approved at:  ${ctx.approvedPath ?? "(unknown)"}`);
      write(`  discovered:   ${ctx.discoveredPath ?? "(unknown)"}`);
      footer("Reinstall the package, then re-approve");
      break;

    default:
      // Unknown trust sub-reason — fall back to the raw structured print.
      write(`Bridge error (trust): ${detail.hint ?? detail.got ?? "unknown"}`);
      write(JSON.stringify(detail, null, 2));
  }

  return lines.map((line) => redactBridgeSecret(line, secret));
}

export function formatBridgeErrorLines(err: unknown, secret = ""): string[] {
  const detail = (err as { detail?: Record<string, unknown> })?.detail;
  if (detail && typeof detail === "object") {
    if ((detail as any).field === "(trust)") {
      return formatTrustErrorLines(detail as TrustErrorDetail, secret);
    }
    return [
      redactBridgeSecret(`Bridge error: ${(detail as any).hint ?? (err as Error).message}`, secret),
      redactBridgeSecret(JSON.stringify(detail, null, 2), secret),
    ];
  }
  return [redactBridgeSecret(`Bridge error: ${(err as Error).message ?? String(err)}`, secret)];
}

/** Register the `flair bridge` command group. */
export function register(program: Command): void {
  // ─── flair bridge ────────────────────────────────────────────────────────────
  // Slice 1: discovery + scaffold. Slice 2: YAML runtime + `import` for Shape A
  // + agentic-stack reference adapter as a built-in.
  // `test` and `export` are still stubbed; Shape B (npm code plugins) too.
  // See docs/bridges.md.

  const bridge = program.command("bridge").description("Manage memory bridges (import/export between Flair and foreign systems)");

  bridge
    .command("list")
    .description("List installed bridges across project YAML, user YAML, npm packages, and built-ins")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const { discover } = await import("../bridges/discover.js");
      const { builtinDiscoveryRecords } = await import("../bridges/builtins/index.js");
      const found = await discover({ builtins: builtinDiscoveryRecords() });
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(found));
        return;
      }
      if (found.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No bridges installed.")}`);
        console.log(`${render.wrap(render.c.dim, "  Add one with:")}     flair bridge scaffold <name> --file`);
        console.log(`${render.wrap(render.c.dim, "  Or install from npm:")} npm install flair-bridge-<name>`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(found.length))} bridge${found.length === 1 ? "" : "s"}\n`);
      const cols: render.TableColumn[] = [
        { label: "name", key: "name", format: (v) => render.wrap(render.c.bold, String(v ?? "—")) },
        {
          label: "kind",
          key: "kind",
          format: (v) => {
            const k = String(v ?? "—");
            return render.wrap(k === "yaml" ? render.c.cyan : k === "api" ? render.c.magenta : render.c.dim, k);
          },
        },
        {
          label: "source",
          key: "source",
          format: (v) => {
            const s = String(v ?? "—");
            return render.wrap(s === "builtin" ? render.c.green : render.c.dim, s);
          },
        },
        { label: "description", key: "description", format: (v) => String(v ?? "") },
      ];
      console.log(render.table(cols, found as unknown as Array<Record<string, unknown>>));
    });

  bridge
    .command("scaffold <name>")
    .description("Emit starter files for a new bridge. Choose --file (YAML, declarative) or --api (TS code plugin)")
    .option("--file", "YAML file-format bridge (shape A)")
    .option("--api", "TypeScript API bridge (shape B)")
    .option("--force", "Overwrite existing files")
    .action(async (name: string, opts) => {
      if (opts.file && opts.api) {
        console.error("Pick one: --file or --api.");
        process.exit(1);
      }
      const { BUILTIN_BY_NAME } = await import("../bridges/builtins/index.js");
      if (BUILTIN_BY_NAME.has(name)) {
        console.error(`"${name}" is a built-in bridge name and can't be scaffolded — pick a different name.`);
        process.exit(1);
      }
      const kind = opts.api ? "api" : "file"; // --file is default
      const { scaffold } = await import("../bridges/scaffold.js");
      try {
        const result = await scaffold({ name, kind, force: !!opts.force });
        if (result.createdFiles.length > 0) {
          console.log(`Created ${result.createdFiles.length} file(s):`);
          for (const p of result.createdFiles) console.log(`  + ${p}`);
        }
        if (result.skippedFiles.length > 0) {
          console.log(`Skipped ${result.skippedFiles.length} existing file(s) (pass --force to overwrite):`);
          for (const p of result.skippedFiles) console.log(`  · ${p}`);
        }
        console.log(`\n${result.summary}`);
      } catch (err: any) {
        console.error(`Scaffold failed: ${err.message}`);
        process.exit(1);
      }
    });

  bridge
    .command("import <name> [src]")
    .description("Import memories from a foreign system into Flair via a bridge (Shape A YAML / built-in)")
    .option("--agent <id>", "Default agent ID for memories that don't carry one (or set FLAIR_AGENT_ID)")
    .option("--cwd <dir>", "Filesystem root the descriptor's relative paths resolve against (default: cwd)")
    .option("--dry-run", "Validate + count, don't write to Flair")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--key <path>", "Ed25519 private key path (default: resolved from agent)")
    .option("--source <path>", "Source directory (for directory-based imports like markdown)")
    .option("--user <id>", "Foreign-system user id for bridges that import one user (e.g. mem0)")
    .option("--base-url <url>", "Base URL of the foreign API for API bridges (e.g. a self-hosted mem0)")
    .option("--api-key-file <path>", "For API bridges with an apiKey option, read the key from a file that has no group/world permissions (chmod 600 recommended); or use the bridge's env var (e.g. MEM0_API_KEY).")
    .action(async (name: string, srcArg: string | undefined, opts) => {
      const agentId: string | undefined = opts.agent ?? process.env.FLAIR_AGENT_ID;
      const cwd: string = opts.cwd ?? srcArg ?? process.cwd();

      const { discover } = await import("../bridges/discover.js");
      const { builtinDiscoveryRecords } = await import("../bridges/builtins/index.js");
      const { loadBridge } = await import("../bridges/runtime/load-bridge.js");
      const { runImport } = await import("../bridges/runtime/import-runner.js");
      const { makeContext } = await import("../bridges/runtime/context.js");
      const { BridgeRuntimeError } = await import("../bridges/types.js");

      const found = await discover({ builtins: builtinDiscoveryRecords() });
      const target = found.find((b) => b.name === name);
      if (!target) {
        console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
        process.exit(1);
      }

      let bridgeApiKey = name === "mem0" ? process.env.MEM0_API_KEY ?? "" : "";
      const safe = (value: string): string => redactBridgeSecret(value, bridgeApiKey);

      let loaded;
      try {
        loaded = await loadBridge(target);
      } catch (err: any) {
        printBridgeError(err, bridgeApiKey);
        process.exit(1);
      }

      const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;

      // A Flair base URL is an origin with an optional path; a query string or
      // fragment on the base is refused before anything is imported — including
      // for an empty or dry-run import, and including a bare trailing "?" or "#"
      // (new URL reports those as an empty search/hash, but the join would drop
      // the base's path). The route's own query string is what gets signed. #1970.
      let parsedBase: URL;
      try {
        parsedBase = new URL(baseUrl);
      } catch {
        console.error(safe("Bridge import failed: the Flair base URL must be a valid URL."));
        process.exit(1);
      }
      if (parsedBase.href.includes("?") || parsedBase.href.includes("#")) {
        console.error(safe(`Bridge import failed: refusing base URL "${baseUrl}": a Flair base URL must not carry a query string or fragment.`));
        process.exit(1);
      }
      // Routes join against the PARSED base, which new URL() has normalized (for
      // example surrounding whitespace removed), so the path sent is the path the
      // base names.
      const joinBase = `${parsedBase.href.replace(/\/+$/, "")}/`;

      const ctx = makeContext({
        bridge: name,
        emit: (event) => process.stderr.write(serializeBridgeLogLine(event, bridgeApiKey) + "\n"),
      });

      // Memory POST: Ed25519-signed when an agent key is available, fall back
      // to the shared `api()` helper otherwise. Mirrors how `flair memory add`
      // works (see the `memory.command("add")` handler above).
      const putMemory = async (body: import("../bridges/runtime/import-runner.js").PutMemoryBody): Promise<void> => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const keyPath: string | null = opts.key ?? resolveKeyPath(body.agentId);
        // One percent-encoded path segment, built once. Join the route onto the
        // base URL's OWN path with exactly one slash between them, preserving any
        // path the base carries (a base like http://h/flair still addresses
        // /flair/Memory/<id>). Build the FINAL url once, then sign the path the
        // request actually carries (#1970); ids of ordinary characters address
        // the same record as before.
        const memoryPath = `/Memory/${encodeRecordId(body.id)}`;
        const memoryUrl = new URL(memoryPath.replace(/^\/+/, ""), joinBase);
        const signedPath = `${memoryUrl.pathname}${memoryUrl.search}`;
        if (keyPath) {
          headers["authorization"] = buildEd25519Auth(body.agentId, "PUT", signedPath, keyPath);
        }
        const res = await fetch(memoryUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`PUT /Memory → HTTP ${res.status}: Flair rejected the write`);
        }
      };

      let lastReportedAt = Date.now();
      let lastReportedOrdinal = 0;
      const onProgress = (ev: import("../bridges/runtime/import-runner.js").ProgressEvent): void => {
        // Throttle in-progress chatter to at most one line every 2s + the
        // final summary. Avoids flooding stdout for big imports.
        if (ev.type === "done") {
          const noun = (n: number): string => `${n} ${n === 1 ? "memory" : "memories"}`;
          if (opts.dryRun) {
            console.log(safe(`\n${target.name}: would import ${noun(ev.total)}. Re-run without --dry-run to write to Flair.`));
          } else {
            console.log(safe(`\n${target.name}: imported ${ev.imported}/${ev.total} memories${ev.skipped > 0 ? ` (${ev.skipped} skipped)` : ""}.`));
          }
          return;
        }
        const now = Date.now();
        if (now - lastReportedAt < 2000 && ev.ordinal - lastReportedOrdinal < 25) return;
        lastReportedAt = now;
        lastReportedOrdinal = ev.ordinal;
        if (ev.type === "memory-imported") {
          process.stdout.write(safe(`\r  ${ev.ordinal} imported (${ev.foreignId ?? ev.flairId})`.padEnd(80)));
        } else if (ev.type === "memory-skipped") {
          process.stdout.write(safe(`\r  ${ev.ordinal} skipped (${ev.reason})`.padEnd(80)));
        }
      };

      try {
        if (loaded.kind === "yaml") {
          if (opts.apiKeyFile !== undefined) {
            throw new Error("--api-key-file requires an API bridge with an apiKey option; YAML imports cannot use it");
          }
          await runImport({
            bridgeName: target.name,
            descriptor: loaded.descriptor,
            cwd,
            agentId,
            dryRun: !!opts.dryRun,
            putMemory,
            onProgress,
            ctx,
          });
        } else {
          // Code plugin: invoke bridge.import(opts, ctx) directly; the plugin
          // returns an AsyncIterable of BridgeMemory that runImport processes.
          if (!loaded.plugin.import) {
            console.error(safe(`Bridge "${name}" is a code plugin without an import() function — can only export through it.`));
            process.exit(1);
          }
          // Code-plugin options: start from the parsed flags, then use only
          // the declared `env` entries as fallbacks. The CLI does not apply
          // descriptor `default` or `required` entries here:
          //   - an option no flag set falls back to the env var it names
          //     (`BridgeOptionSpec.env`, e.g. MEM0_API_KEY);
          //   - `--api-key-file` fills a declared `apiKey` option, read here so
          //     the secret never appears in argv (group/world access refused).
          const pluginOpts: Record<string, unknown> = { ...opts };
          const declaredOptions: Record<string, BridgeOptionSpec> = loaded.plugin.options ?? {};
          if (opts.apiKeyFile !== undefined) {
            if (!declaredOptions.apiKey) {
              throw new Error("--api-key-file requires an API bridge with an apiKey option");
            }
            if (typeof opts.apiKeyFile !== "string" || opts.apiKeyFile.trim() === "") {
              throw new Error("--api-key-file requires a non-empty path");
            }
          }
          for (const [key, spec] of Object.entries(declaredOptions)) {
            if (pluginOpts[key] === undefined && spec.env && process.env[spec.env] !== undefined) {
              pluginOpts[key] = process.env[spec.env];
            }
          }
          if (opts.apiKeyFile !== undefined) {
            pluginOpts.apiKey = readSecretFileSecure(opts.apiKeyFile, "--api-key-file");
          }
          if (typeof pluginOpts.apiKey === "string") bridgeApiKey = pluginOpts.apiKey;
          const source = loaded.plugin.import(pluginOpts, ctx);
          await runImport({
            bridgeName: target.name,
            source,
            cwd,
            agentId,
            dryRun: !!opts.dryRun,
            putMemory,
            onProgress,
            ctx,
          });
        }
      } catch (err: any) {
        if (err instanceof BridgeRuntimeError) {
          printBridgeError(err, bridgeApiKey);
          process.exit(1);
        }
        console.error(safe(`Bridge import failed: ${err?.message ?? err}`));
        process.exit(1);
      }
    });

  bridge
    .command("export <name> <dst>")
    .description("Export memories from Flair to a foreign system via a bridge (Shape A YAML / built-in)")
    .requiredOption("--agent <id>", "Agent ID to export memories for (or set FLAIR_AGENT_ID)")
    .option("--source <tag>", "Filter to memories with a matching `source:` tag (typical for round-tripping a single bridge's data)")
    .option("--subject <subj>", "Filter to memories with a matching `subject:` tag")
    .option("--since <iso>", "Only memories with createdAt >= this ISO-8601 timestamp")
    .option("--cwd <dir>", "Filesystem root the descriptor's relative target paths resolve against (default: cwd)")
    .option("--dry-run", "Validate + count + apply maps, don't write to the target")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--key <path>", "Ed25519 private key path (default: resolved from agent)")
    .action(async (name: string, dst: string, opts) => {
      const agentId: string = opts.agent ?? process.env.FLAIR_AGENT_ID;
      if (!agentId) {
        console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
        process.exit(1);
      }
      const cwd: string = opts.cwd ?? dst;

      const { discover } = await import("../bridges/discover.js");
      const { builtinDiscoveryRecords } = await import("../bridges/builtins/index.js");
      const { loadBridge } = await import("../bridges/runtime/load-bridge.js");
      const { runExport } = await import("../bridges/runtime/export-runner.js");
      const { makeContext } = await import("../bridges/runtime/context.js");
      const { BridgeRuntimeError } = await import("../bridges/types.js");

      const found = await discover({ builtins: builtinDiscoveryRecords() });
      const target = found.find((b) => b.name === name);
      if (!target) {
        console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
        process.exit(1);
      }

      let loaded;
      try {
        loaded = await loadBridge(target);
      } catch (err: any) {
        printBridgeError(err);
        process.exit(1);
      }
      if (loaded.kind === "yaml" && !loaded.descriptor.export) {
        console.error(`Bridge "${name}" has no export block — cannot export through it.`);
        process.exit(1);
      }
      if (loaded.kind === "code" && !loaded.plugin.export) {
        console.error(`Bridge "${name}" is a code plugin without an export() function — can only import through it.`);
        process.exit(1);
      }

      const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
      const ctx = makeContext({ bridge: name });

      // Memory fetcher — paginates GET /Memory?agentId=... applying any
      // descriptor + caller-side filters in memory. Slice 3a does the
      // simplest thing: one round trip, no streaming. Slice 3b can move
      // to cursor-paginated streaming if real corpora warrant it.
      const fetchMemories = async function*(filters: import("../bridges/runtime/export-runner.js").ExportFilters) {
        const params = new URLSearchParams({ agentId });
        if (opts.subject) params.set("subject", opts.subject);
        const headers: Record<string, string> = { "content-type": "application/json" };
        const keyPath: string | null = opts.key ?? resolveKeyPath(agentId);
        const path = `/Memory?${params.toString()}`;
        const url = requestUrl(baseUrl, path);
        if (keyPath) headers["authorization"] = buildEd25519Auth(agentId, "GET", requestTarget(url), keyPath);
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`GET /Memory → ${res.status}: ${text || res.statusText}`);
        }
        const raw = await res.json();
        const all: any[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.items ?? []);
        const sourceFilter = opts.source as string | undefined;
        const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
        for (const m of all) {
          if (sourceFilter && m.source !== sourceFilter) continue;
          if (sinceMs !== null && m.createdAt && new Date(m.createdAt).getTime() < sinceMs) continue;
          yield m as import("../bridges/types.js").BridgeMemory;
        }
        void filters;
      };

      let lastReportedAt = Date.now();
      const onProgress = (ev: import("../bridges/runtime/export-runner.js").ProgressEvent): void => {
        if (ev.type === "done") {
          if (opts.dryRun) {
            console.log(`\n${target.name}: would export ${ev.exported} memor${ev.exported === 1 ? "y" : "ies"} from ${ev.total} total. Re-run without --dry-run to write.`);
          } else {
            console.log(`\n${target.name}: exported ${ev.exported} memor${ev.exported === 1 ? "y" : "ies"} from ${ev.total} total.`);
          }
          return;
        }
        if (ev.type === "target-write") {
          console.log(`  ✓ ${ev.path} (${ev.written} record${ev.written === 1 ? "" : "s"})`);
          return;
        }
        if (ev.type === "target-skipped") {
          console.log(`  · ${ev.path} skipped (${ev.reason})`);
          return;
        }
        // memory-skipped events throttled to one line every 2s
        const now = Date.now();
        if (now - lastReportedAt < 2000) return;
        lastReportedAt = now;
        process.stdout.write(`\r  filtering memory ${ev.ordinal}...`.padEnd(60));
      };

      try {
        if (loaded.kind === "yaml") {
          await runExport({
            descriptor: loaded.descriptor,
            cwd,
            fetchMemories,
            filters: { agentId, subject: opts.subject, source: opts.source, since: opts.since },
            dryRun: !!opts.dryRun,
            ctx,
            onProgress,
          });
        } else {
          // Code plugin export: invoke plugin.export(memoryStream, opts, ctx) directly.
          // Plugin writes to its target however it likes (HTTP, file, etc.).
          if (opts.dryRun) {
            console.log(`${target.name}: dry-run not supported for code-plugin exports; aborting before invoking plugin.export().`);
            process.exit(2);
          }
          const pluginOpts: Record<string, unknown> = { ...opts };
          await loaded.plugin.export!(fetchMemories({ agentId, subject: opts.subject, source: opts.source, since: opts.since }), pluginOpts, ctx);
          console.log(`${target.name}: code-plugin export completed. Record count not reported by the plugin.`);
        }
      } catch (err: any) {
        if (err instanceof BridgeRuntimeError) {
          printBridgeError(err);
          process.exit(1);
        }
        console.error(`Bridge export failed: ${err?.message ?? err}`);
        process.exit(1);
      }
    });

  bridge
    .command("test <name>")
    .description("Round-trip a bridge through its fixture: import → export → re-import → diff. Pass iff the stable fields (content/subject/tags/durability) match.")
    .option("--fixture <path>", "Override the import source path (defaults to descriptor's import.sources[0].path)")
    .option("--cwd <dir>", "Filesystem root the descriptor's relative paths resolve against (default: cwd)")
    .option("--json", "Emit the full RoundTripResult as JSON on stdout")
    .action(async (name: string, opts) => {
      const cwd: string = opts.cwd ?? process.cwd();

      const { discover } = await import("../bridges/discover.js");
      const { builtinDiscoveryRecords } = await import("../bridges/builtins/index.js");
      const { loadBridge } = await import("../bridges/runtime/load-bridge.js");
      const { runRoundTrip } = await import("../bridges/runtime/roundtrip.js");
      const { BridgeRuntimeError } = await import("../bridges/types.js");

      const found = await discover({ builtins: builtinDiscoveryRecords() });
      const target = found.find((b) => b.name === name);
      if (!target) {
        console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
        process.exit(1);
      }

      let loaded;
      try {
        loaded = await loadBridge(target);
      } catch (err: any) {
        printBridgeError(err);
        process.exit(1);
      }

      if (loaded.kind === "code") {
        console.error(`Bridge "${name}" is a code plugin — round-trip testing for code plugins lands in slice 3d (requires mocked fetch transport).`);
        console.error(`For now, code plugins should ship their own tests alongside the npm package.`);
        process.exit(2);
      }

      try {
        const result = await runRoundTrip({
          descriptor: loaded.descriptor,
          cwd,
          fixturePath: opts.fixture,
          // Keep the intermediate export so a failure can print a live path.
          // The next harness start sweeps leftovers older than a minute (flair#1032).
          retainTmpDir: true,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(result.passed ? 0 : 1);
        }
        if (result.passed) {
          console.log(`✅ ${target.name} round-trip passed (${result.expectedCount} record${result.expectedCount === 1 ? "" : "s"}).`);
          process.exit(0);
        }
        console.log(`❌ ${target.name} round-trip failed.`);
        console.log(`   expected ${result.expectedCount} records, got ${result.actualCount} back.`);
        if (result.missingInPass2.length > 0) {
          console.log(`   missing from re-import (${result.missingInPass2.length}):`);
          for (const m of result.missingInPass2.slice(0, 5)) console.log(`     - ${m.key}`);
          if (result.missingInPass2.length > 5) console.log(`     ... ${result.missingInPass2.length - 5} more`);
        }
        if (result.unexpectedInPass2.length > 0) {
          console.log(`   unexpected extras in re-import (${result.unexpectedInPass2.length}):`);
          for (const m of result.unexpectedInPass2.slice(0, 5)) console.log(`     - ${m.key}`);
          if (result.unexpectedInPass2.length > 5) console.log(`     ... ${result.unexpectedInPass2.length - 5} more`);
        }
        if (result.mismatches.length > 0) {
          console.log(`   field mismatches (${result.mismatches.length}):`);
          for (const m of result.mismatches.slice(0, 10)) {
            console.log(`     - record ${m.ordinal} (${m.key}) field ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
          }
          if (result.mismatches.length > 10) console.log(`     ... ${result.mismatches.length - 10} more`);
        }
        console.log(`\n   Intermediate export at: ${result.tmpExportPath}`);
        process.exit(1);
      } catch (err: any) {
        if (err instanceof BridgeRuntimeError) {
          printBridgeError(err);
          process.exit(1);
        }
        console.error(`Bridge test failed: ${err?.message ?? err}`);
        process.exit(1);
      }
    });

  bridge
    .command("allow <name>")
    .description("Approve an npm code-plugin bridge for execution. Approval is pinned to the package's location and package.json contents — a malicious package squatting on the same name in a different node_modules tree will be refused at load-time.")
    .action(async (name: string) => {
      const { discover } = await import("../bridges/discover.js");
      const { builtinDiscoveryRecords } = await import("../bridges/builtins/index.js");
      const { allow } = await import("../bridges/runtime/allow-list.js");

      const found = await discover({ builtins: builtinDiscoveryRecords() });
      const target = found.find((b) => b.name === name);
      if (!target) {
        console.error(`No bridge named "${name}" — run \`flair bridge list\` to see installed bridges.`);
        process.exit(1);
      }
      if (target.source !== "npm-package") {
        console.error(`"${name}" is a ${target.source} bridge; only npm code plugins require allow-list approval.`);
        console.error(`YAML and built-in bridges run via the descriptor runtime and don't execute arbitrary JS.`);
        process.exit(1);
      }

      try {
        const result = await allow(name, target.path);
        if (result.alreadyAllowed) {
          console.log(`${name} was already allowed at ${result.entry.packageDir} — no change.`);
          return;
        }
        const verb = result.updated ? "re-approved" : "allowed";
        console.log(`✓ ${name} ${verb}.`);
        console.log(`  location: ${result.entry.packageDir}`);
        console.log(`  version:  ${result.entry.version ?? "(not declared)"}`);
        console.log(`  digest:   ${result.entry.packageJsonSha256.slice(0, 16)}…`);
        console.log(`  If the package later moves or its package.json content changes, execution is refused until you re-run this command.`);
        console.log(`  Revoke anytime with: flair bridge revoke ${name}`);
      } catch (err: any) {
        console.error(`Failed to approve "${name}": ${err?.message ?? err}`);
        process.exit(1);
      }
    });

  bridge
    .command("revoke <name>")
    .description("Revoke approval for an npm code-plugin bridge (future invocations will require `flair bridge allow <name>` again)")
    .action(async (name: string) => {
      const { revoke } = await import("../bridges/runtime/allow-list.js");
      const result = await revoke(name);
      if (!result.wasAllowed) {
        console.log(`${name} was not on the allow-list — no change.`);
        return;
      }
      console.log(`✓ ${name} revoked. Future invocations require \`flair bridge allow ${name}\` again.`);
    });

  bridge
    .command("allow-list")
    .description("Show the allow-listed code-plugin bridges")
    .option("--json", "Emit raw JSON")
    .action(async (opts) => {
      const { list: listAllowed } = await import("../bridges/runtime/allow-list.js");
      const entries = await listAllowed();
      const mode = render.resolveOutputMode(opts);
      if (mode === "json") {
        console.log(render.asJSON(entries));
        return;
      }
      if (entries.length === 0) {
        console.log(`${render.icons.info} ${render.wrap(render.c.dim, "No code-plugin bridges are allow-listed yet.")}`);
        console.log(`${render.wrap(render.c.dim, "  Allow one with:")} flair bridge allow <name>`);
        return;
      }
      console.log(`${render.wrap(render.c.bold, String(entries.length))} allow-listed code-plugin bridge${entries.length === 1 ? "" : "s"}\n`);
      for (const e of entries) {
        console.log(`${render.wrap(render.c.bold, e.name)}  ${render.wrap(render.c.dim, `(${e.version ?? "—"})`)}  ${render.wrap(render.c.green, "✓ allowed")} ${render.wrap(render.c.dim, e.allowedAt)}`);
        console.log(render.kv("location", render.wrap(render.c.dim, e.packageDir)));
        console.log(render.kv("digest", render.wrap(render.c.dim, `sha256:${e.packageJsonSha256.slice(0, 16)}…`)));
        console.log();
      }
    });

  function printBridgeError(err: unknown, secret = ""): void {
    // Pretty-print BridgeRuntimeError as the structured shape from §10 of the
    // spec. Trust failures retain their dedicated operator-facing rendering.
    for (const line of formatBridgeErrorLines(err, secret)) console.error(line);
  }
}
