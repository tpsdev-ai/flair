/**
 * restore-artifact-preflight-2664.test.ts — flair#2664 slice 1b: `flair
 * restore` verifies the archive against its detached SHA-256 digest before
 * any Agent, Soul or Memory request (src/lib/backup-artifact.ts
 * readBackupArtifact, src/commands/restore.ts).
 *
 * Each command case writes real files (the archive and, unless the case is
 * about its absence, `<archive>.sha256`) and runs src/commands/restore.ts in a
 * child process, the way restore-confirmation-2215.test.ts does: `fetch` is
 * the command's only write path, replaced by a recorder that answers like an
 * empty Flair. A refusal must send no request at all, so it wrote nothing.
 * The per-mode loop runs its cases (admission, missing sidecar, sidecar for
 * other bytes, one changed byte) in all three modes: merge (the default),
 * --replace and --dry-run. The other refusal cases run once, in the mode each
 * names (merge unless stated). Each refusal's message is checked for the
 * file, what did not hold, that restore stopped before any write, and its
 * remedy.
 *
 * Archives here are compact JSON, not the pretty-printed form flair backup
 * writes, and one case changes only whitespace: a digest computed over a
 * re-serialization of the parsed archive, rather than over the exact bytes,
 * fails both.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { readBackupArtifact } from "../../src/lib/backup-artifact.ts";
import { parseRestoreArchive } from "../../src/lib/restore-archive.ts";

const commandPath = join(import.meta.dirname, "../../src/commands/restore.ts");
const commanderPath = join(import.meta.dirname, "../../node_modules/commander/index.js");

const archive = {
  version: 1,
  createdAt: "2026-10-19T00:00:00.000Z",
  source: "http://source.invalid",
  agents: [{ id: "flint", name: "Flint" }],
  souls: [{ id: "flint:identity", agentId: "flint", key: "identity", value: "Flint" }],
  memories: [{ id: "m1", agentId: "flint", content: "Strategy note", durability: "persistent" }],
};
const COMPACT = Buffer.from(JSON.stringify(archive));
const PRETTY = Buffer.from(JSON.stringify(archive, null, 2) + "\n");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sidecarFor = (bytes: Uint8Array, name = "archive.json"): string => `${sha256(bytes)}  ${name}\n`;

type Sidecar = string | Buffer | { directory: true } | { danglingLink: true } | null;
type Call = { method: string; path: string; body?: string };

const MODES = [
  { label: "merge", flags: [] as string[] },
  { label: "--replace", flags: ["--replace"] },
  { label: "--dry-run", flags: ["--dry-run"] },
] as const;

/** Run `flair restore` on `bytes` with `sidecar` beside it; record every request. */
async function restore(bytes: Uint8Array, sidecar: Sidecar, flags: readonly string[] = [], existingPath?: string) {
  const dir = tempDir("flair-restore-preflight-2664-");
  const archivePath = existingPath ?? join(dir, "archive.json");
  if (existingPath === undefined) writeFileSync(archivePath, bytes);
  if (sidecar !== null) {
    if (typeof sidecar === "object" && !Buffer.isBuffer(sidecar)) {
      if ("danglingLink" in sidecar) symlinkSync(join(dir, "no-such-sidecar.sha256"), `${archivePath}.sha256`);
      else mkdirSync(`${archivePath}.sha256`);
    } else writeFileSync(`${archivePath}.sha256`, sidecar);
  }
  const callsPath = join(dir, "calls.json");
  const driver = join(dir, "driver.ts");
  writeFileSync(driver, `
    import { Command } from ${JSON.stringify(commanderPath)};
    import { bindCli, register } from ${JSON.stringify(commandPath)};
    import { writeFileSync } from "node:fs";
    const calls = [];
    const rows = new Map();
    writeFileSync(${JSON.stringify(callsPath)}, "[]");
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      const method = options.method ?? "GET";
      calls.push({ method, path, body: options.body });
      writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
      if (method === "PUT") rows.set(path, JSON.parse(options.body));
      if (method === "DELETE") rows.delete(path);
      if (method !== "GET") return new Response(null, { status: 204 });
      return rows.has(path) ? Response.json(rows.get(path)) : new Response(null, { status: 404 });
    };
    bindCli({ resolveHttpPort: () => { throw new Error("unexpected port lookup"); } });
    const program = new Command();
    register(program);
    await program.parseAsync(["restore", ${JSON.stringify(archivePath)}, "--url", "http://restore.invalid", "--admin-pass", "fixture", ...${JSON.stringify(flags)}], { from: "user" });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)));
  const child = Bun.spawn([process.execPath, driver], { env: { ...env, HOME: dir, USERPROFILE: dir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const calls: Call[] = JSON.parse(readFileSync(callsPath, "utf8"));
  return { archivePath, stdout, stderr, exitCode, calls };
}

const STOPPED = "restore stopped before any write";

/** Refused before any request: non-zero, no completion line, each fragment in stderr. */
function refusedBeforeAnyRequest(result: Awaited<ReturnType<typeof restore>>, ...fragments: string[]) {
  expect(result.exitCode).not.toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.stdout).not.toContain("Restore complete");
  expect(result.stdout).not.toContain("Dry run complete");
  expect(result.stdout).not.toContain("Restoring from");
  for (const fragment of fragments) expect(result.stderr).toContain(fragment);
}

describe("restore verifies the archive's digest sidecar before any request (#2664)", () => {
  for (const { label, flags } of MODES) {
    test(`${label}: a matching sidecar over the exact bytes admits the archive`, async () => {
      const result = await restore(COMPACT, sidecarFor(COMPACT), flags);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Archive SHA-256: ${sha256(COMPACT)} (matches ${result.archivePath}.sha256)`);
      if (label === "--dry-run") {
        expect(result.calls).toEqual([]);
        expect(result.stdout).toContain("Dry run complete");
        return;
      }
      expect(result.stdout).toContain("Restore complete");
      const puts = result.calls.filter((call) => call.method === "PUT");
      expect(puts.map((call) => call.path)).toEqual(["/Agent/flint", "/Soul/flint%3Aidentity", "/Memory/m1"]);
      expect(JSON.parse(puts[2]!.body!)).toEqual(archive.memories[0]);
    });

    test(`${label}: a missing sidecar refuses, naming the sidecar path`, async () => {
      const result = await restore(COMPACT, null, flags);
      refusedBeforeAnyRequest(result, `archive digest sidecar ${result.archivePath}.sha256 not found`,
        STOPPED, "put the .sha256 file written with this archive beside it, or take a new backup");
    });

    test(`${label}: a sidecar for other bytes refuses, naming both digests`, async () => {
      const other = Buffer.from(JSON.stringify({ ...archive, source: "http://other.invalid" }));
      const result = await restore(COMPACT, sidecarFor(other), flags);
      refusedBeforeAnyRequest(result, `archive ${result.archivePath} does not match its digest sidecar`,
        `its bytes hash to SHA-256 ${sha256(COMPACT)}`, `records ${sha256(other)}`, STOPPED,
        "Use a copy of the archive and sidecar that match each other", "or take a new backup");
      // The mismatch does not say which file is at fault.
      expect(result.stderr).not.toContain("changed after");
    });

    test(`${label}: an archive with one byte changed refuses`, async () => {
      const tampered = Buffer.from(COMPACT);
      const at = tampered.indexOf("Strategy note") + "Strategy".length - 1;
      tampered[at] = "z".charCodeAt(0);
      expect(JSON.parse(tampered.toString()).memories[0].content).toBe("Strategz note");
      const result = await restore(tampered, sidecarFor(COMPACT), flags);
      refusedBeforeAnyRequest(result, "does not match its digest sidecar", `records ${sha256(COMPACT)}`);
    });
  }

  test("a whitespace-only change to the archive refuses, although it parses to the same value", async () => {
    const spaced = Buffer.from(PRETTY.toString().replace('"version": 1', '"version":  1'));
    expect(JSON.parse(spaced.toString())).toEqual(JSON.parse(PRETTY.toString()));
    const result = await restore(spaced, sidecarFor(PRETTY));
    refusedBeforeAnyRequest(result, "does not match its digest sidecar", `its bytes hash to SHA-256 ${sha256(spaced)}`);
  });

  for (const [label, sidecar, why] of [
    ["the right digest in uppercase", sidecarFor(COMPACT).toUpperCase().replace("ARCHIVE.JSON", "archive.json"), "expected 64 lowercase hex"],
    ["no trailing line feed", sidecarFor(COMPACT).trimEnd(), "does not end with a line feed"],
    ["a second line", `${sidecarFor(COMPACT)}${sidecarFor(COMPACT)}`, "more than one line"],
    ["an empty file", "", "the file is empty"],
  ] as const) {
    test(`a sidecar that is not a digest line refuses: ${label}`, async () => {
      const result = await restore(COMPACT, sidecar);
      refusedBeforeAnyRequest(result, `archive digest sidecar ${result.archivePath}.sha256 is not a SHA-256 digest line`, why,
        STOPPED, "Put the .sha256 file written with this archive beside it, or take a new backup");
    });
  }

  test("a sidecar that cannot be read refuses", async () => {
    const result = await restore(COMPACT, { directory: true });
    refusedBeforeAnyRequest(result, `cannot read archive digest sidecar ${result.archivePath}.sha256 (EISDIR)`, STOPPED,
      "Check that the sidecar is a file this user can read, or put the .sha256 file written with this archive beside it");
  });

  test("a symbolic link at the sidecar path whose target is missing is unreadable, not missing", async () => {
    const result = await restore(COMPACT, { danglingLink: true });
    refusedBeforeAnyRequest(result, `archive digest sidecar ${result.archivePath}.sha256 is a symbolic link whose target does not exist`,
      STOPPED, "Replace it with the .sha256 file written with this archive");
    expect(result.stderr).not.toContain("not found");
  });

  test("an archive that cannot be read refuses", async () => {
    const dir = tempDir("flair-restore-preflight-2664-");
    const archivePath = join(dir, "archive-dir.json");
    mkdirSync(archivePath);
    const result = await restore(Buffer.alloc(0), null, [], archivePath);
    refusedBeforeAnyRequest(result, `cannot read archive ${archivePath} (EISDIR)`, STOPPED,
      "Check the path and that this user can read the file");
  });

  test("a verified archive the parser refuses is not restored: a repeated key", async () => {
    const duplicated = Buffer.from(JSON.stringify(archive).replace('"content":"Strategy note"', '"content":"Strategy note","content":"Other"'));
    const result = await restore(duplicated, sidecarFor(duplicated));
    refusedBeforeAnyRequest(result, `archive ${result.archivePath} matches its digest sidecar but is not a restorable archive`,
      "duplicate object key", "duplicate-key at /memories/0/content", STOPPED, "Restore from another backup, or take a new one");
  });

  test("a verified archive the parser refuses is not restored: a repeated Memory id", async () => {
    const twice = Buffer.from(JSON.stringify({ ...archive, memories: [archive.memories[0], archive.memories[0]] }));
    const result = await restore(twice, sidecarFor(twice), ["--replace"]);
    refusedBeforeAnyRequest(result, "appears more than once", "duplicate-id at /memories/1/id");
  });

  test("a digest mismatch is reported before a parse refusal", async () => {
    const broken = Buffer.from("{ not json");
    const result = await restore(broken, sidecarFor(COMPACT));
    refusedBeforeAnyRequest(result, "does not match its digest sidecar");
    expect(result.stderr).not.toContain("invalid-json");
  });
});

describe("readBackupArtifact hashes and parses one read of the archive (#2664)", () => {
  /** A reader that serves `first` on the archive's first read and `later` on any further read. */
  function swappingReader(archivePath: string, first: Buffer, later: Buffer) {
    const reads: string[] = [];
    const readFile = (path: string): Buffer => {
      reads.push(path);
      if (path === archivePath) return reads.filter((p) => p === archivePath).length === 1 ? first : later;
      return readFileSync(path);
    };
    return { reads, readFile };
  }

  test("the archive is read once, and the archive returned is parsed from the bytes the digest covers", () => {
    const dir = tempDir("flair-restore-one-buffer-2664-");
    const archivePath = join(dir, "archive.json");
    const swapped = Buffer.from(JSON.stringify({ ...archive, memories: [{ ...archive.memories[0], content: "swapped" }] }));
    writeFileSync(`${archivePath}.sha256`, sidecarFor(COMPACT));
    const { reads, readFile } = swappingReader(archivePath, COMPACT, swapped);
    const result = readBackupArtifact(archivePath, { readFile });
    expect(reads).toEqual([archivePath, `${archivePath}.sha256`]);
    if (!result.ok) throw new Error(`expected the artifact to verify: ${result.reason}`);
    expect(result.sha256).toBe(sha256(COMPACT));
    const expected = parseRestoreArchive(COMPACT);
    if (!expected.ok) throw new Error("fixture must parse");
    expect(result.archive).toEqual(expected.archive);
    expect(result.archive.memories[0]!.content).toBe("Strategy note");
  });

  test("a sidecar for bytes served on a later read does not admit the bytes read first", () => {
    const dir = tempDir("flair-restore-one-buffer-2664-");
    const archivePath = join(dir, "archive.json");
    const later = Buffer.from(JSON.stringify({ ...archive, source: "http://later.invalid" }));
    writeFileSync(`${archivePath}.sha256`, sidecarFor(later));
    const { readFile } = swappingReader(archivePath, COMPACT, later);
    expect(readBackupArtifact(archivePath, { readFile })).toMatchObject({ ok: false, code: "digest-mismatch", sha256: sha256(COMPACT) });
  });

  test("an archive that cannot be read is refused before the sidecar is read", () => {
    const dir = tempDir("flair-restore-one-buffer-2664-");
    const archivePath = join(dir, "missing.json");
    writeFileSync(`${archivePath}.sha256`, sidecarFor(COMPACT));
    const reads: string[] = [];
    const readFile = (path: string): Buffer => {
      reads.push(path);
      return readFileSync(path);
    };
    expect(readBackupArtifact(archivePath, { readFile })).toMatchObject({ ok: false, code: "archive-unreadable" });
    expect(reads).toEqual([archivePath]);
  });
});
