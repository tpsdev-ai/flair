/**
 * backup-artifact-publish-2664.test.ts — flair#2664 slice 1b: a backup
 * archive and its digest sidecar are published as one coherent artifact by a
 * single writer (src/lib/backup-artifact.ts publishBackupArtifact).
 *
 * The published names are `<out>` and `<out>.sha256`. Each table case starts
 * from one of four states: no files; an earlier consistent pair; an earlier
 * archive with no sidecar; or a stale sidecar with no archive (the one
 * inconsistent start). It stops the publication immediately before one step:
 * - "crash": a child process publishing for real is killed with SIGKILL at
 *   that step, so no cleanup or error handling runs;
 * - "failure": the step throws in-process, so the error path runs;
 * - "observed": the state at each step is recorded without stopping.
 * Every table case asserts the exact state the published names hold (the
 * table in expectedStates). Apart from the stale-sidecar start before step 5,
 * every state in the table is consistent: no sidecar, or a sidecar whose
 * digest is the SHA-256 of the archive bytes beside it. Concurrent writers
 * are out of scope here.
 *
 * Other cases: the published bytes and modes; input that is not in canonical
 * JSON form (the digest covers the exact bytes given, not a re-serialization);
 * a refusal from the caller's verify; staged bytes changed before read-back;
 * a staging directory that cannot be removed, after success and after a
 * failure; and the sidecar line format, including canonical escaping.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const archiveValue = (label: string) => ({
  version: 1, createdAt: "2026-10-19T00:00:00.000Z", source: `http://${label}.invalid`,
  agents: [{ id: "flint" }], souls: [], memories: [{ id: `m-${label}`, agentId: "flint", content: `${label} content é ✓` }],
});
const archiveText = (label: string): string => JSON.stringify(archiveValue(label), null, 2) + "\n";
const OLD = archiveText("old");
const NEW = archiveText("new");
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Start = "no files" | "earlier pair" | "earlier archive alone" | "stale sidecar alone";
const STARTS: readonly Start[] = ["no files", "earlier pair", "earlier archive alone", "stale sidecar alone"];

function setUp(start: Start): { dir: string; out: string } {
  const dir = tempDir("flair-backup-artifact-2664-");
  const out = join(dir, "flair-backup.json");
  if (start === "earlier pair" || start === "earlier archive alone") writeFileSync(out, OLD);
  if (start === "earlier pair" || start === "stale sidecar alone") {
    writeFileSync(`${out}.sha256`, formatBackupDigest(sha256(OLD), "flair-backup.json"));
  }
  return { dir, out };
}

/** What the published names hold, in words; a mismatched or unreadable pair says so. */
function publishedState(out: string): string {
  const archive = existsSync(out) ? readFileSync(out) : null;
  const sidecar = existsSync(`${out}.sha256`) ? readFileSync(`${out}.sha256`) : null;
  const which = archive === null ? null : archive.equals(Buffer.from(OLD)) ? "earlier" : archive.equals(Buffer.from(NEW)) ? "new" : "unknown";
  if (sidecar === null) return which === null ? "nothing" : `${which} archive alone`;
  const recorded = parseBackupDigest(sidecar);
  if (!recorded.ok) return `INVALID: unreadable sidecar (${recorded.reason})`;
  if (archive === null) return recorded.sha256 === sha256(OLD) ? "stale sidecar alone" : "MISMATCH: new sidecar with no archive";
  if (recorded.sha256 !== sha256(archive)) return `MISMATCH: ${which} archive beside a sidecar for other bytes`;
  return `${which} pair`;
}

/** The state a stop immediately before each step leaves, then the completed state. */
function expectedStates(start: Start): Record<BackupPublishStep | "completed", string> {
  const before = { "no files": "nothing", "earlier pair": "earlier pair", "earlier archive alone": "earlier archive alone", "stale sidecar alone": "stale sidecar alone" }[start];
  const oldDigestRemoved = start === "earlier pair" || start === "earlier archive alone" ? "earlier archive alone" : "nothing";
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

describe("publishing a backup archive with its digest sidecar, single writer (#2664)", () => {
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

  test("the digest covers the exact bytes given, not a re-serialization: non-canonical input", () => {
    const { out } = setUp("no files");
    // Neither the compact nor the pretty-printed form of this document.
    const serialized = `{ "version":1,"agents" : [ {"id":"flint"} ], "souls":[],\n"memories":[]  }\n`;
    const value = JSON.parse(serialized);
    expect(serialized).not.toBe(JSON.stringify(value));
    expect(serialized).not.toBe(JSON.stringify(value, null, 2) + "\n");
    const result = publishBackupArtifact({ outputPath: out, serialized });
    expect(result.sha256).toBe(sha256(serialized));
    expect(readFileSync(out, "utf8")).toBe(serialized);
    expect(readFileSync(`${out}.sha256`, "latin1")).toBe(`${sha256(serialized)}  flair-backup.json\n`);
    expect(readBackupArtifact(out)).toMatchObject({ ok: true, sha256: sha256(serialized) });
  });

  for (const start of STARTS) {
    test(`from ${start}: the state at every step is the expected state`, () => {
      const { out } = setUp(start);
      const observed: Record<string, string> = {};
      publishBackupArtifact({ outputPath: out, serialized: NEW }, { beforeStep: (step) => { observed[step] = publishedState(out); } });
      observed.completed = publishedState(out);
      expect(observed).toEqual(expectedStates(start));
    });
  }

  for (const start of STARTS) {
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
        } else if (step === "publish-archive" && (start === "earlier pair" || start === "stale sidecar alone")) {
          expect(message).toContain(`the previous digest sidecar ${out}.sha256 was removed and ${out} was not replaced`);
        } else {
          expect(message).toContain("nothing was published");
        }
        expect(message).not.toContain("could not be removed");
        expect(stagingDirs(dir)).toEqual([]);
      });
    }
  }

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

  test("a staging directory that cannot be removed after publication is reported, and the pair stays published", () => {
    const { dir, out } = setUp("earlier pair");
    const result = publishBackupArtifact({ outputPath: out, serialized: NEW }, {
      removeDir: () => { throw Object.assign(new Error("injected removal failure"), { code: "EBUSY" }); },
    });
    const [staging] = stagingDirs(dir);
    expect(result).toEqual({ sha256: sha256(NEW), digestPath: `${out}.sha256`, stagingLeft: { path: join(dir, staging!), reason: "EBUSY" } });
    expect(publishedState(out)).toBe("new pair");
    rmSync(join(dir, staging!), { recursive: true, force: true });
  });

  test("a staging directory that cannot be removed after a failure is reported with the publication state", () => {
    const { dir, out } = setUp("earlier pair");
    let message = "";
    try {
      publishBackupArtifact({ outputPath: out, serialized: NEW }, {
        beforeStep: (step) => { if (step === "publish-digest") throw new Error("injected publish-digest failure"); },
        removeDir: () => { throw Object.assign(new Error("injected removal failure"), { code: "EACCES" }); },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    const [staging] = stagingDirs(dir);
    expect(message).toContain("injected publish-digest failure");
    expect(message).toContain(`${out} holds the new archive but its digest sidecar ${out}.sha256 was not written`);
    expect(message).toContain(`the staging directory ${join(dir, staging!)} could not be removed (EACCES): remove it by hand`);
    expect(publishedState(out)).toBe("new archive alone");
    rmSync(join(dir, staging!), { recursive: true, force: true });
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
    expect(parseBackupDigest(Buffer.from(formatBackupDigest(digest, "back\\slash.json")))).toEqual({ ok: true, sha256: digest });
  });

  for (const [label, text, reason] of [
    ["empty", "", "the file is empty"],
    ["no trailing line feed", `${digest}  a.json`, "does not end with a line feed"],
    ["two lines", `${digest}  a.json\n${digest}  b.json\n`, "more than one line"],
    ["CRLF ending", `${digest}  a.json\r\n`, "expected 64 lowercase hex"],
    ["uppercase hex", `${digest.toUpperCase()}  a.json\n`, "expected 64 lowercase hex"],
    ["63 hex characters", `${digest.slice(1)}  a.json\n`, "expected 64 lowercase hex"],
    ["one space", `${digest} a.json\n`, "expected 64 lowercase hex"],
    ["binary-mode marker", `${digest} *a.json\n`, "expected 64 lowercase hex"],
    ["no name", `${digest}  \n`, "expected 64 lowercase hex"],
    ["digest only", `${digest}\n`, "expected 64 lowercase hex"],
    ["an unescaped backslash in the name", `${digest}  back\\slash.json\n`, "does not start with the escape marker"],
    ["the escape marker with no escape in the name", `\\${digest}  plain.json\n`, "is not escaped as"],
    ["the escape marker with an unknown escape", `\\${digest}  tab\\tname.json\n`, "is not escaped as"],
    ["the escape marker with a lone trailing backslash", `\\${digest}  name\\n.json\\\n`, "is not escaped as"],
  ] as const) {
    test(`refuses a sidecar line: ${label}`, () => {
      const result = parseBackupDigest(Buffer.from(text));
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toContain(reason);
    });
  }
});
