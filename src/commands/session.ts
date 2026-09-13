/**
 * session.ts — `flair session` command group (flair#1631 / epic #1618).
 *
 * Extracted from src/cli.ts with ZERO behavior change. Owns the `session`
 * commander registration and its `session snapshot {create,list,restore}`
 * handlers (FLAIR-AGENT-CONTEXT-TIERS-B), including the SNAPSHOT_ROOT /
 * sessionSnapshotDir helpers and the flair#903 fail-closed archive validation.
 *
 * SECURITY: the flair#903 tamper-validation posture (validateSnapshotArchive
 * runs BEFORE the target dir is created; default tar extract flags stay as
 * containment defense-in-depth, deliberately not preservePaths) is moved
 * verbatim. No extraction or validation behavior was altered.
 *
 * Shared cli.ts-local helpers are injected via bindCli() so this module never
 * imports src/cli.ts (avoids the import cycle and keeps it inside the strict
 * tsconfig.check.src.json set).
 *
 * Compiled with the rest of src/ under tsconfig.check.src.json (strict).
 */
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { create as tarCreate, extract as tarExtract, list as tarList } from "tar";
import type { ReadEntry as TarReadEntry } from "tar";
import { validateSnapshotArchive } from "../lib/safe-snapshot-extract.js";

export type SessionCli = {
  humanBytes: (n: number) => string;
  relativeTime: (iso: string | null | undefined) => string;
  pkgVersion: string;
};

let cli: SessionCli;

/** Bind shared CLI helpers. cli.ts calls this immediately before register(program). */
export function bindCli(fns: SessionCli): void {
  cli = fns;
}

const humanBytes = (n: number): string => cli.humanBytes(n);
const relativeTime = (iso: string | null | undefined): string => cli.relativeTime(iso);

/** Register the `flair session` command group (flair#1631). */
export function register(program: Command): void {
  // ─── flair session snapshot ──────────────────────────────────────────────────
  // Slice 2 of FLAIR-AGENT-CONTEXT-TIERS-B. Snapshot a
  // session jsonl + label metadata into a tar.gz under ~/.flair/snapshots/<agent>/sessions/.
  //
  // Three subcommands: create | list | restore. Mirrors FLAIR-NIGHTLY-REM's
  // snapshot pattern (tar.gz, 600 perms, 30-day retention enforced separately).
  //
  // Standalone-callable today; harness slices 3+4 will wire it into the
  // session-reset pipeline.

  const SNAPSHOT_ROOT = resolve(homedir(), ".flair", "snapshots");

  function sessionSnapshotDir(agent: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(agent)) throw new Error(`invalid agent id: ${agent}`);
    return resolve(SNAPSHOT_ROOT, agent, "sessions");
  }

  const session = program.command("session").description("Agent session lifecycle (snapshot/restore for FLAIR-AGENT-CONTEXT-TIERS-B)");
  const sessionSnapshot = session.command("snapshot").description("Manage session snapshots (tar.gz of session jsonl + metadata)");

  sessionSnapshot
    .command("create")
    .description("Create a session snapshot tar.gz")
    .requiredOption("--agent <id>", "Agent the session belongs to")
    .requiredOption("--session-file <path>", "Path to the session jsonl to snapshot (e.g. /tmp/openclaw/openclaw-2026-05-03.log)")
    .option("--label <text>", "Label for the snapshot file (e.g. ops-ID); default: ISO timestamp")
    .action(async (opts) => {
      const sessionFile = resolve(opts.sessionFile);
      if (!existsSync(sessionFile)) {
        console.error(`Error: --session-file does not exist: ${sessionFile}`);
        process.exit(1);
      }
      const dir = sessionSnapshotDir(opts.agent);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const safeLabel = opts.label ? String(opts.label).replace(/[^a-zA-Z0-9._-]/g, "_") : ts;
      const tarballName = opts.label ? `${safeLabel}-${ts}.tar.gz` : `${ts}.tar.gz`;
      const tarballPath = resolve(dir, tarballName);

      // Write a metadata.json into a tmp dir alongside the session file for the
      // tarball, so the snapshot is self-describing.
      const meta = {
        agent: opts.agent,
        label: opts.label ?? null,
        sessionFile,
        sessionFileSize: statSync(sessionFile).size,
        createdAt: new Date().toISOString(),
        flairVersion: cli.pkgVersion,
      };
      const tmpDir = resolve(dir, `.tmp-${process.pid}-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      try {
        const sessionBaseName = sessionFile.split("/").pop() ?? "session.jsonl";
        writeFileSync(resolve(tmpDir, sessionBaseName), readFileSync(sessionFile));
        writeFileSync(resolve(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
        await tarCreate(
          { gzip: true, cwd: tmpDir, file: tarballPath, portable: true },
          [sessionBaseName, "metadata.json"],
        );
        // Tarball perms: 600 (owner-only) — matches FLAIR-NIGHTLY-REM
        chmodSync(tarballPath, 0o600);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      const size = statSync(tarballPath).size;
      console.log(tarballPath);
      console.error(`  agent: ${opts.agent}`);
      console.error(`  label: ${opts.label ?? "(none)"}`);
      console.error(`  size:  ${humanBytes(size)}`);
    });

  sessionSnapshot
    .command("list")
    .description("List session snapshots for an agent (or all agents)")
    .option("--agent <id>", "Filter to a single agent")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      if (!existsSync(SNAPSHOT_ROOT)) {
        if (opts.json) { console.log("[]"); return; }
        console.log("(no snapshots — ~/.flair/snapshots/ does not exist yet)");
        return;
      }
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      type Row = { agent: string; file: string; path: string; size: number; mtime: string };
      const rows: Row[] = [];
      const agents = opts.agent ? [opts.agent] : readdirSync(SNAPSHOT_ROOT).filter((d) => {
        try { return statSync(resolve(SNAPSHOT_ROOT, d)).isDirectory(); } catch { return false; }
      });
      for (const a of agents) {
        const dir = resolve(SNAPSHOT_ROOT, a, "sessions");
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".tar.gz")) continue;
          const p = resolve(dir, f);
          const s = statSync(p);
          rows.push({ agent: a, file: f, path: p, size: s.size, mtime: s.mtime.toISOString() });
        }
      }
      rows.sort((a, b) => b.mtime.localeCompare(a.mtime));

      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (rows.length === 0) { console.log("(no snapshots)"); return; }

      const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
      const fileW = Math.max(20, ...rows.map((r) => r.file.length));
      console.log(`  ${"agent".padEnd(agentW)}  ${"file".padEnd(fileW)}  size      age`);
      for (const r of rows) {
        console.log(`  ${r.agent.padEnd(agentW)}  ${r.file.padEnd(fileW)}  ${humanBytes(r.size).padEnd(8)}  ${relativeTime(r.mtime)}`);
      }
      console.log(`\n${rows.length} snapshot${rows.length > 1 ? "s" : ""}.`);
    });

  sessionSnapshot
    .command("restore")
    .description("Extract a session snapshot to a target directory")
    .requiredOption("--snapshot <path>", "Path to the .tar.gz snapshot")
    .option("--target <dir>", "Directory to extract into (default: <snapshot>.restored next to the snapshot)")
    .option("--dry-run", "List the snapshot's contents without extracting")
    .action(async (opts) => {
      const snapshotPath = resolve(opts.snapshot);
      if (!existsSync(snapshotPath)) {
        console.error(`Error: snapshot does not exist: ${snapshotPath}`);
        process.exit(1);
      }

      if (opts.dryRun) {
        console.log("(dry-run) snapshot contents:");
        const entries: string[] = [];
        await tarList({ file: snapshotPath, onReadEntry: (entry: TarReadEntry) => entries.push(`  ${entry.path}  (${humanBytes(entry.size ?? 0)})`) });
        for (const e of entries) console.log(e);
        return;
      }

      const targetDir = opts.target
        ? resolve(opts.target)
        : `${snapshotPath}.restored`;
      if (existsSync(targetDir)) {
        console.error(`Error: target directory already exists: ${targetDir}`);
        console.error(`  Pass --target <new-path> or remove the existing dir.`);
        process.exit(1);
      }
      // flair#903 — fail CLOSED on a tampered archive. node-tar's defaults below
      // do contain malicious entries (leading "/" stripped, ".." entries
      // dropped, no writing through a symlink — verified on the pinned tar
      // against all four vectors), but they discard those entries SILENTLY: the
      // restore printed the target dir as a plain success minus the parts it
      // never mentioned. Validation runs BEFORE the target directory is even
      // created — a tampered snapshot aborts the whole restore, names the
      // offending entry, and writes nothing (same posture as the data-dir
      // restore's extractSnapshotSafely). The default extract flags stay as
      // containment defense-in-depth — deliberately NOT preservePaths; if that
      // flag is ever added here, this call MUST move to extractSnapshotSafely.
      // See src/lib/safe-snapshot-extract.ts.
      try {
        await validateSnapshotArchive({ file: snapshotPath, targetDir });
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      await tarExtract({ file: snapshotPath, cwd: targetDir });
      console.log(targetDir);
      console.error(`  extracted to: ${targetDir}`);
    });
}
