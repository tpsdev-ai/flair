/**
 * Output writers for export targets. Slice 3a ships `jsonl` and `json`.
 * `yaml` and `markdown-frontmatter` land with slice 3b alongside any
 * built-in that needs them.
 *
 * Each writer takes a stream of "shaped output records" (whatever the
 * descriptor's `map:` produced) and writes to a target file path.
 * Atomic via tmp-file + rename, so a crash mid-write doesn't leave a
 * half-written target.
 */

import { promises as fsp } from "node:fs";
import { dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { YamlFormat } from "../types.js";
import { BridgeRuntimeError } from "../types.js";

export async function writeRecords(
  bridge: string,
  path: string,
  format: YamlFormat,
  records: Iterable<Record<string, unknown>>,
): Promise<{ written: number }> {
  switch (format) {
    case "jsonl": return writeJsonl(bridge, path, records);
    case "json":  return writeJson(bridge, path, records);
    case "yaml":  return writeYaml(bridge, path, records);
    case "markdown-frontmatter":
      throw new BridgeRuntimeError({
        bridge,
        op: "export",
        path,
        field: "format",
        expected: "jsonl | json | yaml",
        got: "markdown-frontmatter",
        hint: "markdown-frontmatter writer lands in slice 3b along with its reference adapter",
      });
  }
}

async function writeJsonl(
  bridge: string,
  path: string,
  records: Iterable<Record<string, unknown>>,
): Promise<{ written: number }> {
  const tmpPath = await stageTmp(bridge, path, "export");
  let written = 0;
  try {
    const fh = await fsp.open(tmpPath, "w");
    try {
      for (const r of records) {
        await fh.write(JSON.stringify(r) + "\n");
        written++;
      }
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, path);
  } catch (err: any) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new BridgeRuntimeError({
      bridge,
      op: "export",
      path,
      field: "(write)",
      expected: "successful write",
      got: err?.message ?? String(err),
      hint: `failed writing to ${path}: ${err?.message ?? err}`,
    });
  }
  return { written };
}

async function writeJson(
  bridge: string,
  path: string,
  records: Iterable<Record<string, unknown>>,
): Promise<{ written: number }> {
  const arr: Record<string, unknown>[] = [];
  for (const r of records) arr.push(r);
  const tmpPath = await stageTmp(bridge, path, "export");
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(arr, null, 2));
    await fsp.rename(tmpPath, path);
  } catch (err: any) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new BridgeRuntimeError({
      bridge,
      op: "export",
      path,
      field: "(write)",
      expected: "successful write",
      got: err?.message ?? String(err),
      hint: `failed writing to ${path}: ${err?.message ?? err}`,
    });
  }
  return { written: arr.length };
}

async function writeYaml(
  bridge: string,
  path: string,
  records: Iterable<Record<string, unknown>>,
): Promise<{ written: number }> {
  const arr: Record<string, unknown>[] = [];
  for (const r of records) arr.push(r);
  const tmpPath = await stageTmp(bridge, path, "export");
  try {
    await fsp.writeFile(tmpPath, yaml.dump(arr));
    await fsp.rename(tmpPath, path);
  } catch (err: any) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new BridgeRuntimeError({
      bridge,
      op: "export",
      path,
      field: "(write)",
      expected: "successful write",
      got: err?.message ?? String(err),
      hint: `failed writing to ${path}: ${err?.message ?? err}`,
    });
  }
  return { written: arr.length };
}

/**
 * Allocate a sibling temp file in the same directory as `targetPath`.
 * Same-fs rename is atomic on POSIX; using a sibling guarantees that.
 */
async function stageTmp(bridge: string, targetPath: string, op: string): Promise<string> {
  const dir = dirname(targetPath);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err: any) {
    throw new BridgeRuntimeError({
      bridge,
      op: "export",
      path: targetPath,
      field: "(mkdir)",
      expected: "writable directory",
      got: err?.message ?? String(err),
      hint: `could not create directory ${dir}: ${err?.message ?? err}`,
    });
  }
  return `${dir}/.${basename(targetPath)}.${op}.${randomUUID().slice(0, 8)}.tmp`;
}
