/**
 * export.ts — content-only logical export fallback (ladder step 4):
 * "Content-only logical export fallback: embeddings/indexes dominate
 * data-dir size; the irreplaceable part (memory content + provenance)
 * exports far smaller. If the physical snapshot doesn't fit but the content
 * export does → export content, proceed (derived is recomputable by
 * definition)." (flair#695, space-pressure step 4)
 *
 * Exports SOURCE_FIELDS ONLY (+id) — never derived fields (embedding is the
 * dominant size driver this exists to skip) — as JSONL, one row per line,
 * under the SAME 0700/0600 discipline as snapshot.ts.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./dir-safety.js";
import { sourceFieldsFor } from "./source-fields.js";
import type { SourceTable } from "./types.js";

export interface CreateContentExportOpts {
  migrationId: string;
  table: SourceTable;
  rows: Array<Record<string, unknown>>;
  fromVersion: string;
}

export interface ContentExportDeps {
  exportRoot: string;
  now: () => Date;
}

export interface ContentExportResult {
  dir: string;
  path: string;
  bytes: number;
  rowCount: number;
}

function sanitizeIdPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createContentOnlyExport(
  opts: CreateContentExportOpts,
  deps: ContentExportDeps,
): ContentExportResult {
  const now = deps.now();
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(deps.exportRoot, `${sanitizeIdPart(opts.migrationId)}-${opts.table}-${iso}`);
  ensureSecureDir(dir);

  const fields = sourceFieldsFor(opts.table);
  const lines = opts.rows.map((row) => {
    const picked: Record<string, unknown> = { id: (row as { id?: unknown }).id };
    for (const f of fields) picked[f] = (row as Record<string, unknown>)[f] ?? null;
    return JSON.stringify(picked);
  });
  const body = lines.join("\n") + (lines.length ? "\n" : "");

  const path = join(dir, `${opts.table}.jsonl`);
  writeSecureFile(path, body, dir);

  const metaPath = join(dir, "manifest.json");
  writeSecureFile(
    metaPath,
    JSON.stringify(
      { migrationId: opts.migrationId, table: opts.table, fromVersion: opts.fromVersion, createdAt: now.toISOString(), rowCount: opts.rows.length },
      null,
      2,
    ) + "\n",
    dir,
  );

  return { dir, path, bytes: statSync(path).size, rowCount: opts.rows.length };
}
