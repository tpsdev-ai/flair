/**
 * bridge.ts — `flair bridge` command group (flair#1628 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. This file owns the
 * group's commander registration (list / import / export / test / scaffold /
 * roundtrip) and its action handlers, plus the two group-specific inline error
 * printers (`printBridgeError`, `printTrustError`). All bridge runtime logic
 * still lives under src/bridges/. Two shared cli.ts-local helpers
 * (`api`, `resolveHttpPort`) are bound before register().
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 * Do not import src/cli.ts from here — that would cycle and pull the
 * non-strict entry into the strict check.
 */
import { Command } from "commander";
import * as render from "../render.js";
import { resolveKeyPath, buildEd25519Auth } from "../lib/auth-resolve.js";

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

      let loaded;
      try {
        loaded = await loadBridge(target);
      } catch (err: any) {
        printBridgeError(err);
        process.exit(1);
      }

      const baseUrl: string = opts.url ?? `http://127.0.0.1:${resolveHttpPort(opts)}`;
      const ctx = makeContext({ bridge: name });

      // Memory POST: Ed25519-signed when an agent key is available, fall back
      // to the shared `api()` helper otherwise. Mirrors how `flair memory add`
      // works (see the `memory.command("add")` handler above).
      const putMemory = async (body: import("../bridges/runtime/import-runner.js").PutMemoryBody): Promise<void> => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const keyPath: string | null = opts.key ?? resolveKeyPath(body.agentId);
        if (keyPath) {
          headers["authorization"] = buildEd25519Auth(body.agentId, "PUT", `/Memory/${body.id}`, keyPath);
        }
        const res = await fetch(`${baseUrl}/Memory/${encodeURIComponent(body.id)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`PUT /Memory/${body.id} → ${res.status}: ${text || res.statusText}`);
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
            console.log(`\n${target.name}: would import ${noun(ev.total)}. Re-run without --dry-run to write to Flair.`);
          } else {
            console.log(`\n${target.name}: imported ${ev.imported}/${ev.total} memories${ev.skipped > 0 ? ` (${ev.skipped} skipped)` : ""}.`);
          }
          return;
        }
        const now = Date.now();
        if (now - lastReportedAt < 2000 && ev.ordinal - lastReportedOrdinal < 25) return;
        lastReportedAt = now;
        lastReportedOrdinal = ev.ordinal;
        if (ev.type === "memory-imported") {
          process.stdout.write(`\r  ${ev.ordinal} imported (${ev.foreignId ?? ev.flairId})`.padEnd(80));
        } else if (ev.type === "memory-skipped") {
          process.stdout.write(`\r  ${ev.ordinal} skipped (${ev.reason})`.padEnd(80));
        }
      };

      try {
        if (loaded.kind === "yaml") {
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
            console.error(`Bridge "${name}" is a code plugin without an import() function — can only export through it.`);
            process.exit(1);
          }
          // Code-plugin options: pass through all --X flags as a single object.
          // The plugin's declared `options` descriptor validates what it actually cares about.
          const pluginOpts: Record<string, unknown> = { ...opts };
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
          printBridgeError(err);
          process.exit(1);
        }
        console.error(`Bridge import failed: ${err?.message ?? err}`);
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
        if (keyPath) headers["authorization"] = buildEd25519Auth(agentId, "GET", path, keyPath);
        const res = await fetch(`${baseUrl}${path}`, { headers });
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

  function printBridgeError(err: unknown): void {
    // Pretty-print BridgeRuntimeError as the structured shape from §10 of the
    // spec, plus a one-line human summary so the operator gets both.
    const detail = (err as { detail?: Record<string, unknown> })?.detail;
    if (detail && typeof detail === "object") {
      // Trust-check failures get a dedicated, operator-facing rendering.
      // Dumping the full spec-§10 JSON is useful when an operator is
      // debugging a broken YAML descriptor; for trust errors it buries the
      // one thing that matters — the command to re-approve.
      if ((detail as any).field === "(trust)") {
        printTrustError(detail as any);
        return;
      }
      console.error(`Bridge error: ${(detail as any).hint ?? (err as Error).message}`);
      console.error(JSON.stringify(detail, null, 2));
    } else {
      console.error(`Bridge error: ${(err as Error).message ?? String(err)}`);
    }
  }

  function printTrustError(detail: { bridge?: string; got?: string; context?: Record<string, string> }): void {
    const name = detail.bridge ?? "(unknown)";
    const ctx = detail.context ?? {};
    const reapprove = `  flair bridge allow ${name}`;
    const bar = "─".repeat(60);

    const header = (title: string) => {
      console.error("");
      console.error(`⚠ ${title} — ${name}`);
      console.error(bar);
    };

    const footer = (label: string) => {
      console.error("");
      console.error(`${label}:`);
      console.error(reapprove);
      console.error("");
    };

    switch (detail.got) {
      case "not-allowed":
        header("Approval required");
        console.error("This bridge is an npm code plugin — it runs arbitrary JavaScript.");
        console.error("First-use approval is required before Flair will execute it.");
        footer("Approve it with");
        return;

      case "path-mismatch":
        header("Trust check failed: package location changed");
        console.error("A different package with the same name was discovered. This is how");
        console.error("local squatting attacks present — a planted `node_modules/flair-bridge-*`");
        console.error("in an unrelated project tree.");
        console.error("");
        console.error(`  approved: ${ctx.approvedPath ?? "(unknown)"}`);
        console.error(`            version ${ctx.approvedVersion ?? "?"} at ${ctx.approvedAt ?? "?"}`);
        console.error(`  now:      ${ctx.observedPath ?? "(unknown)"}`);
        footer("If the new location is intentional, re-approve");
        return;

      case "digest-mismatch":
        header("Trust check failed: package contents changed");
        console.error("The package.json at the approved location has changed since you");
        console.error("approved this bridge. This fires on every upgrade — it's a trust");
        console.error("event, not an error. If the update is intentional, re-approve.");
        console.error("");
        console.error(`  location:          ${ctx.packagePath ?? "(unknown)"}`);
        console.error(`  approved version:  ${ctx.approvedVersion ?? "?"}   (at ${ctx.approvedAt ?? "?"})`);
        console.error(`  approved digest:   sha256:${(ctx.approvedDigest ?? "").slice(0, 16)}…`);
        console.error(`  observed digest:   sha256:${(ctx.observedDigest ?? "").slice(0, 16)}…`);
        footer("Re-approve");
        return;

      case "entry-incomplete":
        header("Trust check failed: approval record is incomplete");
        console.error("The allow-list entry for this bridge is missing a location or digest.");
        console.error("This usually means the record was created by a pre-fix Flair version");
        console.error("(0.6.0 / 0.6.1) that only stored the name. Re-approve to upgrade.");
        footer("Re-approve");
        return;

      case "package-missing":
        header("Trust check failed: approved package missing on disk");
        console.error("The package location recorded at allow-time is no longer readable.");
        console.error("");
        console.error(`  approved at:  ${ctx.approvedPath ?? "(unknown)"}`);
        console.error(`  discovered:   ${ctx.discoveredPath ?? "(unknown)"}`);
        footer("Reinstall the package, then re-approve");
        return;

      default:
        // Unknown trust sub-reason — fall back to the raw structured print.
        console.error(`Bridge error (trust): ${(detail as any).hint ?? detail.got ?? "unknown"}`);
        console.error(JSON.stringify(detail, null, 2));
    }
  }
}
