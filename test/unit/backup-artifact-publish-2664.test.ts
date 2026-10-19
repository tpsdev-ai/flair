/**
 * backup-artifact-publish-2664.test.ts — flair#2664 slice 1b: a backup
 * archive and its digest sidecar are published as one coherent artifact
 * (src/lib/backup-artifact.ts publishBackupArtifact).
 *
 * The published names are `<out>` and `<out>.sha256`. A state is consistent
 * when there is no sidecar, or the sidecar's digest is the SHA-256 of the
 * archive bytes beside it. Each case starts from one of three states (no
 * files, an earlier consistent pair, an earlier archive with no sidecar) and
 * stops the publication immediately before one step:
 * - "crash": a child process publishing for real is killed with SIGKILL at
 *   that step, so no cleanup or error handling runs;
 * - "failure": the step throws in-process, so the error path runs;
 * - "observed": the state at each step is recorded without stopping.
 * Every case asserts the exact state the published names hold (the table
 * below), and that each one is consistent.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  BACKUP_PUBLISH_STEPS,
  formatBackupDigest,
  parseBackupDigest,
  publishBackupArtifact,
  readBackupArtifact,
  type BackupPublishStep,
} from "../../src/lib/backup-artifact.ts";

const MODULE = join(import.meta.dir, "..", "..", "src", "lib", "backup-artifact.ts");

const archiveText = (label: string): string =>
  JSON.stringify({
    version: 1, createdAt: "2026-10-19T00:00:00.000Z", source: `http://${label}.invalid`,
    agents: [{ id: "flint" }], souls: [], memories: [{ id: `m-${label}`, agentId: "flint", content: `${label} content é ✓` }],
  }, null, 2) + "\n";
const OLD = archiveText("old");
const NEW = archiveText("new");
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Start = "no files" | "earlier pair" | "earlier archive alone";
const STARTS: readonly Start[] = ["no files", "earlier pair", "earlier archive alone"];

function setUp(start: Start): { dir: string; out: string } {
  const dir = tempDir("flair-backup-artifact-2664-");
  const out = join(dir, "flair-backup.json");
  if (start !== "no files") writeFileSync(out, OLD);
  if (start === "earlier pair") writeFileSync(`${out}.sha256`, formatBackupDigest(sha256(OLD), "flair-backup.json"));
  return { dir, out };
}

/** What the published names hold, in words; anything inconsistent says so. */
function publishedState(out: string): string {
  const archive = existsSync(out) ? readFileSync(out) : null;
  const sidecar = existsSync(`${out}.sha256`) ? readFileSync(`${out}.sha256`) : null;
  const which = archive === null ? null : archive.equals(Buffer.from(OLD)) ? "earlier" : archive.equals(Buffer.from(NEW)) ? "new" : "unknown";
  if (sidecar === null) return which === null ? "nothing" : `${which} archive alone`;
  const recorded = parseBackupDigest(sidecar);
  if (!recorded.ok) return `INCONSISTENT: unreadable sidecar (${recorded.reason})`;
  if (archive === null) return "INCONSISTENT: sidecar with no archive";
  if (recorded.sha256 !== sha256(archive)) return `INCONSISTENT: ${which} archive beside a sidecar for other bytes`;
  return `${which} pair`;
}

/** The state a stop immediately before each step leaves, then the completed state. */
function expectedStates(start: Start): Record<BackupPublishStep | "completed", string> {
  const before = { "no files": "nothing", "earlier pair": "earlier pair", "earlier archive alone": "earlier archive alone" }[start];
  const oldDigestRemoved = start === "no files" ? "nothing" : "earlier archive alone";
  return {
    "stage-archive": before,
    "sync-archive": before,
    "verify-archive": before,
    "stage-digest": before,
    "remove-old-digest": before,
    "publish-archive": oldDigestRemoved,
    "publish-digest": "new archive alone",
    completed: "new pair",
  };
}

const stagingDirs = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith(".flair-backup-"));

/** Run a real publication in a child process and SIGKILL it immediately before `step`. */
async function crashAt(out: string, step: BackupPublishStep): Promise<void> {
  const dir = tempDir("flair-backup-artifact-crash-2664-");
  const script = join(dir, "crash.ts");
  const text = join(dir, "archive.txt");
  writeFileSync(text, NEW);
  writeFileSync(script, `
import { readFileSync } from "node:fs";
import { publishBackupArtifact } from ${JSON.stringify(MODULE)};
const [out, text, crashStep] = process.argv.slice(2);
publishBackupArtifact({ outputPath: out, serialized: readFileSync(text, "utf8") }, {
  beforeStep(step) { if (step === crashStep) process.kill(process.pid, "SIGKILL"); },
});
console.log("published");
`);
  const child = Bun.spawn([process.execPath, script, out, text, step], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(child.signalCode, `the child must die at ${step}: ${stdout}${stderr}`).toBe("SIGKILL");
  expect(stdout).not.toContain("published");
}

describe("publishing a backup archive with its digest sidecar (#2664)", () => {
  test("publishes the exact bytes and a sidecar holding their SHA-256, both mode 0600, and leaves no staging directory", () => {
    const { dir, out } = setUp("earlier pair");
    const result = publishBackupArtifact({ outputPath: out, serialized: NEW });
    expect(result).toEqual({ sha256: sha256(NEW), digestPath: `${out}.sha256` });
    expect(readFileSync(out).equals(Buffer.from(NEW, "utf-8"))).toBe(true);
    expect(readFileSync(`${out}.sha256`, "latin1")).toBe(`${sha256(Buffer.from(NEW, "utf-8"))}  flair-backup.json\n`);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(`${out}.sha256`).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["flair-backup.json", "flair-backup.json.sha256"]);
    const verified = readBackupArtifact(out);
    expect(verified).toMatchObject({ ok: true, sha256: sha256(NEW) });
  });

  for (const start of STARTS) {
    test(`from ${start}: the state at every step is the expected consistent state`, () => {
      const { out } = setUp(start);
      const observed: Record<string, string> = {};
      publishBackupArtifact({ outputPath: out, serialized: NEW }, { beforeStep: (step) => { observed[step] = publishedState(out); } });
      observed.completed = publishedState(out);
      expect(observed).toEqual(expectedStates(start));
    });
  }

  for (const start of ["no files", "earlier pair"] as const) {
    for (const step of BACKUP_PUBLISH_STEPS) {
      test(`from ${start}: a crash (SIGKILL) at ${step} leaves ${expectedStates(start)[step]}`, async () => {
        const { out } = setUp(start);
        await crashAt(out, step);
        expect(publishedState(out)).toBe(expectedStates(start)[step]);
      }, 60_000);
    }
  }

  for (const start of STARTS) {
    for (const step of BACKUP_PUBLISH_STEPS) {
      test(`from ${start}: a failure at ${step} leaves ${expectedStates(start)[step]}, says so, and removes the staging directory`, () => {
        const { dir, out } = setUp(start);
        let thrown: unknown;
        try {
          publishBackupArtifact({ outputPath: out, serialized: NEW }, {
            beforeStep: (current) => { if (current === step) throw new Error(`injected ${step} failure`); },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(`injected ${step} failure`);
        const state = expectedStates(start)[step];
        expect(publishedState(out)).toBe(state);
        if (state === "new archive alone") {
          expect(message).toContain(`${out} holds the new archive but its digest sidecar ${out}.sha256 was not written`);
        } else if (step === "publish-archive" && start === "earlier pair") {
          expect(message).toContain(`the previous digest sidecar ${out}.sha256 was removed and ${out} was not replaced`);
        } else {
          expect(message).toContain("nothing was published");
        }
        expect(stagingDirs(dir)).toEqual([]);
      });
    }
  }

  test("a stale sidecar with no archive beside it is removed before the new archive is published", () => {
    const { out } = setUp("no files");
    writeFileSync(`${out}.sha256`, formatBackupDigest(sha256(OLD), "flair-backup.json"));
    const observed: Record<string, string> = {};
    publishBackupArtifact({ outputPath: out, serialized: NEW }, { beforeStep: (step) => { observed[step] = publishedState(out); } });
    expect(observed["remove-old-digest"]).toBe("INCONSISTENT: sidecar with no archive");
    expect(observed["publish-archive"]).toBe("nothing");
    expect(observed["publish-digest"]).toBe("new archive alone");
    expect(publishedState(out)).toBe("new pair");
  });

  test("a refusal from the caller's verify publishes nothing", () => {
    const { dir, out } = setUp("earlier pair");
    expect(() => publishBackupArtifact({
      outputPath: out, serialized: NEW, verify: () => { throw new Error("archive count does not match"); },
    })).toThrow("archive count does not match; nothing was published");
    expect(publishedState(out)).toBe("earlier pair");
    expect(stagingDirs(dir)).toEqual([]);
  });

  test("staged bytes that differ from the serialized archive are refused, so the digest never covers other bytes", () => {
    const { dir, out } = setUp("earlier pair");
    expect(() => publishBackupArtifact({ outputPath: out, serialized: NEW }, {
      beforeStep: (step) => {
        if (step !== "verify-archive") return;
        const [staging] = stagingDirs(dir);
        writeFileSync(join(dir, staging!, "archive.json"), NEW.replace("new content", "new_content"));
      },
    })).toThrow("archive bytes on disk do not match the serialized archive; nothing was published");
    expect(publishedState(out)).toBe("earlier pair");
  });
});

describe("the digest sidecar line (#2664)", () => {
  const digest = sha256("archive");

  test("is the sha256sum line for the archive's file name", () => {
    expect(formatBackupDigest(digest, "flair-backup-2026-10-19T00-00-00.json")).toBe(`${digest}  flair-backup-2026-10-19T00-00-00.json\n`);
    expect(parseBackupDigest(Buffer.from(`${digest}  any-name.json\n`))).toEqual({ ok: true, sha256: digest });
  });

  test("a name with a backslash, line feed or carriage return is escaped as GNU coreutils does, and still parses", () => {
    const line = formatBackupDigest(digest, "a\\b\nc\rd.json");
    expect(line).toBe(`\\${digest}  a\\\\b\\nc\\rd.json\n`);
    expect(parseBackupDigest(Buffer.from(line))).toEqual({ ok: true, sha256: digest });
  });

  for (const [label, text] of [
    ["empty", ""],
    ["no trailing line feed", `${digest}  a.json`],
    ["two lines", `${digest}  a.json\n${digest}  b.json\n`],
    ["CRLF ending", `${digest}  a.json\r\n`],
    ["uppercase hex", `${digest.toUpperCase()}  a.json\n`],
    ["63 hex characters", `${digest.slice(1)}  a.json\n`],
    ["one space", `${digest} a.json\n`],
    ["binary-mode marker", `${digest} *a.json\n`],
    ["no name", `${digest}  \n`],
    ["digest only", `${digest}\n`],
  ] as const) {
    test(`refuses a sidecar line: ${label}`, () => {
      expect(parseBackupDigest(Buffer.from(text))).toMatchObject({ ok: false });
    });
  }
});
