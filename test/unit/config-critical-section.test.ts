/**
 * config-critical-section.test.ts — flair#1778 slice 2c-i-b fixtures.
 *
 * Covers the primitive (`src/lib/config-critical-section.ts`): the deterministic
 * negative/positive controls for the critical section, the identity holds, the
 * fresh-attempt protocol, lock hygiene, metadata preservation, atomic
 * visibility, and the import boundary over the migrated sink module.
 *
 * Every case drives the REAL primitive through its production entry point. The
 * two stage barriers (`afterPreObserve`, `afterRead`) and the env barrier are
 * TEST-ONLY and inert in production.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigCriticalSection } from "../../src/lib/config-critical-section.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf-8");

let dir: string;
let cfg: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2cib-"));
  cfg = join(dir, "settings.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => `${cfg}.lock`;
const writeConfig = (s: string) => writeFileSync(cfg, s);

// ── fixture 11 — identity holds ─────────────────────────────────────────────

describe("fixture 11 — the configured path is swapped mid-flight", () => {
  it("becomes a symlink to a decoy between observe and re-observe → HELD, decoy UNCHANGED, no write through the link", () => {
    writeConfig("ORIGINAL");
    const decoy = join(dir, "decoy.json");
    writeFileSync(decoy, "DECOY");
    let swapped = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: {
        afterPreObserve: () => {
          if (swapped) return;
          swapped = true;
          renameSync(cfg, join(dir, "original-moved.json"));
          symlinkSync(decoy, cfg);
        },
      },
    });
    expect(res.status).toBe("held");
    expect(res.changed).toBe("entry-type");
    expect(readFileSync(decoy, "utf-8")).toBe("DECOY");
    expect(readFileSync(join(dir, "original-moved.json"), "utf-8")).toBe("ORIGINAL");
    expect(existsSync(lockPath())).toBe(false); // lock released
  });

  it("parent directory replaced by a symlink to a decoy tree → HELD (parent identity)", () => {
    const realParent = join(dir, "conf");
    mkdirSync(realParent);
    const p = join(realParent, "settings.json");
    writeFileSync(p, "ORIGINAL");
    const decoyTree = join(dir, "decoy-tree");
    mkdirSync(decoyTree);
    writeFileSync(join(decoyTree, "settings.json"), "DECOY");
    let swapped = false;
    const res = withConfigCriticalSection(p, () => ({ write: enc("NEW") }), {
      testHooks: {
        afterPreObserve: () => {
          if (swapped) return;
          swapped = true;
          renameSync(realParent, join(dir, "conf-moved"));
          symlinkSync(decoyTree, realParent);
        },
      },
    });
    expect(res.status).toBe("held");
    expect(res.changed).toBe("parent-identity");
    expect(readFileSync(join(decoyTree, "settings.json"), "utf-8")).toBe("DECOY");
    expect(readFileSync(join(dir, "conf-moved", "settings.json"), "utf-8")).toBe("ORIGINAL");
  });

  it("a DANGLING symlink is a hold, never 'absent'", () => {
    symlinkSync(join(dir, "does-not-exist.json"), cfg);
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }));
    expect(res.status).toBe("held");
    expect(res.message).toContain("cannot resolve");
    expect(existsSync(join(dir, "does-not-exist.json"))).toBe(false);
  });
});

// ── fixture 12 — the verdict is the in-lock snapshot ────────────────────────

describe("fixture 12 — the decision is made on the IN-LOCK bytes", () => {
  it("an in-place content mutation between observe and the in-lock read changes the VERDICT", () => {
    writeConfig("PIN=1");
    let mutated = false;
    const res = withConfigCriticalSection(
      cfg,
      (bytes) => {
        const text = decode(bytes!);
        return text === "PIN=2"
          ? { hold: `held on the in-lock bytes: ${text}` }
          : { write: enc("NEW") };
      },
      {
        testHooks: {
          afterPreObserve: () => {
            if (mutated) return;
            mutated = true;
            writeConfig("PIN=2"); // in place: same inode, new content
          },
        },
      },
    );
    expect(res.status).toBe("held");
    expect(res.message).toContain("PIN=2");
    expect(readFileSync(cfg, "utf-8")).toBe("PIN=2"); // the mutated bytes stand
  });
});

// ── fresh-attempt protocol ──────────────────────────────────────────────────

describe("fresh-attempt protocol", () => {
  it("a committed replacement by another writer is HELD, then retried and lands", () => {
    writeConfig("BASE");
    let replaced = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("B-EDIT") }), {
      testHooks: {
        afterPreObserve: (attempt) => {
          if (attempt === 1 && !replaced) {
            replaced = true;
            // Another writer commits an atomic replacement (a NEW inode).
            const tmp = `${cfg}.a-tmp`;
            writeFileSync(tmp, "A-EDIT");
            renameSync(tmp, cfg);
          }
        },
      },
    });
    expect(res.status).toBe("written");
    expect(res.attempts).toBe(2);
    expect(readFileSync(cfg, "utf-8")).toBe("B-EDIT");
  });

  it("a RETARGET during the wait is a FINAL hold after attempt 1", () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    symlinkSync(a, cfg);
    let retargeted = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: {
        afterPreObserve: () => {
          if (retargeted) return;
          retargeted = true;
          unlinkSync(cfg);
          symlinkSync(b, cfg);
        },
      },
    });
    expect(res.status).toBe("held");
    expect(res.attempts).toBe(1);
    expect(readFileSync(a, "utf-8")).toBe("A");
    expect(readFileSync(b, "utf-8")).toBe("B");
    // The comparator's DOCUMENTED priority checks a symlink entry's OWN link
    // identity BEFORE the resolved path. unlink+symlink installs a FRESH symlink
    // inode: on APFS (and any filesystem that does not reuse freed inodes) the
    // entry identity changes, so the hold is labelled "entry-identity"; on ext4
    // the freed inode MAY be reused, leaving the entry identity equal and the
    // retarget surfacing as "resolved-path". Both are correct FINAL holds — which
    // field is named is a property of inode reuse, NOT of the contract — so
    // assert the guaranteed set, never one platform-dependent field.
    expect(["entry-identity", "resolved-path", "target-identity"]).toContain(res.changed ?? "");
  });
});

// ── fixture 13 — non-regular destinations (F1) ──────────────────────────────

describe("fixture 13 — a non-regular destination is REFUSED by name (F1)", () => {
  // The refusal is BEFORE the read and before any temp: a FIFO read would block,
  // and a rename onto a FIFO would destroy it. Nothing may be staged, nothing
  // written, the lock released.
  const expectNoStagingNoLock = (): void => {
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  };

  it("a DIRECTORY destination is refused before any temp is created; lock released", () => {
    mkdirSync(cfg); // the resolved target is a directory
    let tempSeen = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: { afterTempCreate: () => { tempSeen = true; } },
    });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("not a regular file");
    expect(tempSeen).toBe(false); // refused BEFORE the staging temp exists
    expect(statSync(cfg).isDirectory()).toBe(true); // the destination is untouched
    expect(existsSync(lockPath())).toBe(false); // lock released
    expectNoStagingNoLock();
  });

  it("a FIFO destination is refused before any temp is created (never read, never replaced)", () => {
    execFileSync("mkfifo", [cfg]); // a named pipe: reading it would block, so the refusal must precede the read
    let tempSeen = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: { afterTempCreate: () => { tempSeen = true; } },
    });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("not a regular file");
    expect(tempSeen).toBe(false);
    expect(statSync(cfg).isFIFO()).toBe(true); // the FIFO survives, not replaced by a regular file
    expect(existsSync(lockPath())).toBe(false);
    expectNoStagingNoLock();
  });
});

// ── fixture 14 — the link's OWN identity, alone (F3) ────────────────────────

describe("fixture 14 — a replaced SYMLINK entry holds on its own link identity (F3)", () => {
  it("a NEW symlink to the SAME target holds with changed === 'entry-identity'", () => {
    const target = join(dir, "target.json");
    writeFileSync(target, "TARGET");
    symlinkSync(target, cfg);
    // Pre-create the replacement while the ORIGINAL link still exists, so the
    // two symlinks are allocated at different times and are guaranteed distinct
    // inodes — this fixture names entry-identity, so it must not depend on
    // whether the filesystem reuses a freed inode (cf. fixture 12's retarget,
    // where the label legitimately varies). rename then swaps the link with no
    // window of absence.
    const replacement = join(dir, "link-replacement");
    symlinkSync(target, replacement);
    expect(lstatSync(replacement).ino).not.toBe(lstatSync(cfg).ino);

    let swapped = false;
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: {
        afterPreObserve: () => {
          if (swapped) return;
          swapped = true;
          renameSync(replacement, cfg);
        },
      },
    });
    expect(res.status).toBe("held");
    expect(res.changed).toBe("entry-identity"); // ONLY the link's own inode changed
    expect(res.attempts).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe("TARGET"); // nothing written through the link
    expect(readFileSync(cfg, "utf-8")).toBe("TARGET");
    expect(existsSync(lockPath())).toBe(false);
  });
});

// ── lock hygiene ────────────────────────────────────────────────────────────

describe("lock hygiene", () => {
  const fastRetry = { attempts: 2, delayMs: 1 };

  it("(a) a stale lock refuses by name with the holder metadata; nothing written, lock NOT reclaimed", () => {
    writeConfig("BASE");
    writeFileSync(lockPath(), "12345 2026-09-22T00:00:00.000Z host.example\n");
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), { lockRetry: fastRetry });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("12345");
    expect(res.message).toContain("host.example");
    expect(res.message).toContain("Quiesce Flair writers");
    expect(readFileSync(cfg, "utf-8")).toBe("BASE");
    expect(existsSync(lockPath())).toBe(true);
  });

  it("(b) a blank / malformed lock file also refuses", () => {
    writeConfig("BASE");
    writeFileSync(lockPath(), "");
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), { lockRetry: fastRetry });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("not a readable holder record");
    expect(readFileSync(cfg, "utf-8")).toBe("BASE");
  });

  it("(c) decide() throwing releases the lock and leaves the file unchanged", () => {
    writeConfig("BASE");
    expect(() =>
      withConfigCriticalSection(cfg, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath())).toBe(false);
    expect(readFileSync(cfg, "utf-8")).toBe("BASE");
  });

  it("(d) a backup FAILURE refuses BEFORE decide and writes nothing", () => {
    writeConfig("BASE");
    let decided = false;
    const res = withConfigCriticalSection(cfg, () => { decided = true; return { write: enc("NEW") }; }, {
      backup: () => { throw new Error("no space"); },
    });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("backup failed");
    expect(decided).toBe(false);
    expect(readFileSync(cfg, "utf-8")).toBe("BASE");
    expect(existsSync(lockPath())).toBe(false);
  });
});

// ── metadata ────────────────────────────────────────────────────────────────

describe("metadata preservation (temp+rename replaces the inode)", () => {
  it("positive control: success removes lock and temp, bytes updated, 0644 preserved", () => {
    writeConfig("BASE");
    chmodSync(cfg, 0o644);
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }));
    expect(res.status).toBe("written");
    expect(readFileSync(cfg, "utf-8")).toBe("NEW");
    expect(existsSync(lockPath())).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(statSync(cfg).mode & 0o777).toBe(0o644);
  });

  it("a NEW file is created 0600", () => {
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }));
    expect(res.status).toBe("written");
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
  });

  it("the staging temp is created 0600, never broader", () => {
    writeConfig("BASE");
    chmodSync(cfg, 0o644);
    const observed: { tempMode: number | null } = { tempMode: null };
    const res = withConfigCriticalSection(cfg, () => ({ write: enc("NEW") }), {
      testHooks: { afterTempCreate: (tempPath) => { observed.tempMode = statSync(tempPath).mode & 0o777; } },
    });
    expect(res.status).toBe("written");
    expect(observed.tempMode).toBe(0o600);
  });

  // F2 (flair#1778 2c-i-b r2): the docblock claims setuid/setgid/sticky are
  // stripped; here is the test that fails when the strip is skipped.
  it("F2: setuid/setgid/sticky are STRIPPED from the replacement, the rest preserved", () => {
    // bun's chmod/fchmod SILENTLY DROPS setuid/setgid/sticky (measured: Linux x64,
    // bun 1.3.10), so a bun process can neither install the precondition NOR
    // observe the strip — an in-process fixture would pass with the strip
    // REMOVED. node's chmod keeps the bits, so drive the SAME production
    // primitive there, in a node child. The primitive is a leaf (node:fs,
    // node:crypto, node:os, node:path only), so it transpiles to a standalone
    // module with no local imports to chase.
    const childDir = join(dir, "f2-node");
    mkdirSync(childDir);
    const primitiveSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "lib", "config-critical-section.ts"),
      "utf-8",
    );
    const modPath = join(childDir, "config-critical-section.mjs");
    writeFileSync(modPath, new Bun.Transpiler({ loader: "ts" }).transformSync(primitiveSrc));
    const runner = join(childDir, "runner.mjs");
    writeFileSync(
      runner,
      [
        "import { withConfigCriticalSection } from " + JSON.stringify(modPath) + ";",
        'import { chmodSync, writeFileSync, statSync } from "node:fs";',
        "const [cfg, ...specials] = process.argv.slice(2);",
        "const out = [];",
        "for (const s of specials) {",
        '  writeFileSync(cfg, "BASE");',
        "  chmodSync(cfg, parseInt(s, 8));",
        "  const pre = statSync(cfg).mode & 0o7777;",
        '  const res = withConfigCriticalSection(cfg, () => ({ write: new TextEncoder().encode("NEW") }));',
        "  out.push({ special: s, pre: pre.toString(8), status: res.status, mode: (statSync(cfg).mode & 0o7777).toString(8) });",
        "}",
        'console.log("RESULT=" + JSON.stringify(out));',
      ].join("\n"),
      "utf-8",
    );
    const r = spawnSync("node", [runner, cfg, "4755", "2755", "1755"], { encoding: "utf8", timeout: 20000 });
    expect(r.status).toBe(0);
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT=")) ?? "";
    expect(line.startsWith("RESULT=")).toBe(true);
    const results = JSON.parse(line.slice("RESULT=".length)) as Array<{ special: string; pre: string; status: string; mode: string }>;
    expect(results).toHaveLength(3);
    for (const x of results) {
      expect(x.pre).toBe(x.special); // the ORIGINAL really carried the special bits
      expect(x.status).toBe("written");
      expect(x.mode).toBe((parseInt(x.special, 8) & 0o777).toString(8)); // stripped, rest preserved
    }
  });
});

// ── fixture 8b — atomic visibility (a concurrent reader never sees a partial file)

describe("fixture 8b — atomic visibility", () => {
  it("a reader polling during the write sees OLD or NEW bytes, never a partial file", async () => {
    const LEN = 1 << 19; // 512 KiB
    const OLD = "O".repeat(LEN);
    const NEW = "N".repeat(LEN);
    writeConfig(OLD);

    const readerScript = join(dir, "reader.mjs");
    writeFileSync(
      readerScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const [path, len, ms, armed] = process.argv.slice(2);",
        "const NEW = 'N'.repeat(Number(len));",
        "const OLD = readFileSync(path, 'utf-8');",
        'writeFileSync(armed, "1");',
        "const deadline = Date.now() + Number(ms);",
        "let oldc = 0, newc = 0, partial = 0, reads = 0;",
        "while (Date.now() < deadline) {",
        "  let s; try { s = readFileSync(path, 'utf-8'); } catch { continue; }",
        "  reads++;",
        "  if (s === OLD) oldc++; else if (s === NEW) newc++; else partial++;",
        "}",
        "console.log(JSON.stringify({ reads, oldc, newc, partial }));",
      ].join("\n"),
      "utf-8",
    );
    const armed = join(dir, "armed");
    const child = spawn(process.execPath, [readerScript, cfg, String(LEN), "600", armed], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    await waitForFile(armed, 5000);

    const res = withConfigCriticalSection(cfg, () => ({ write: enc(NEW) }));
    expect(res.status).toBe("written");

    const code: number | null = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    const seen = JSON.parse(out.trim().split("\n").pop()!);
    expect(seen.partial).toBe(0); // never a partial file
    expect(seen.newc).toBeGreaterThan(0); // observed the new bytes
  }, 20000);
});

async function waitForFile(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── boundary — the sinks write only through the primitive ───────────────────

describe("import boundary over the migrated sink module", () => {
  it("src/hook-install.ts routes every config write through the primitive; no raw write of the settings path remains", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "hook-install.ts"), "utf-8");
    // Names checked: readFileSync / writeFileSync / copyFileSync / takeBackup.
    expect(src).toContain('from "./lib/config-critical-section.js"');
    // No direct in-place write of the resolved settings path.
    expect(src).not.toMatch(/writeFileSync\(\s*path\b/);
    // The old raw backup helper is gone (the primitive owns the backup).
    expect(src).not.toContain("function takeBackup(");
    for (const sink of ["installHook", "repinSessionStartHook", "uninstallHook", "installContinuityHooks", "uninstallContinuityHooks"]) {
      expect(functionBody(src, sink)).toContain("withConfigCriticalSection(");
    }
  });
});

/** Crude export-boundary slicer: from `export function <name>(` to the next `\nexport `. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const rest = src.slice(start);
  const end = rest.indexOf("\nexport ");
  return end < 0 ? rest : rest.slice(0, end);
}

// ── boundary — the DOCTOR hook sinks write only through the primitive ─────────

describe("import boundary over the migrated DOCTOR sink module", () => {
  it("src/doctor-client.ts routes each of the four hook-file writers through the primitive; fixClaudeMdBootstrap is the only raw write left", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "doctor-client.ts"), "utf-8");
    expect(src).toContain('from "./lib/config-critical-section.js"');

    // PER-FUNCTION form — each of the four hook-file writers' bodies must
    // carry the primitive. A MODULE-WIDE `writeFileSync` regex would wrongly
    // flag the deliberately retained CLAUDE.md writer (a DIFFERENT file), so
    // the raw-write audit below is scoped per function by name.
    const sinks = [
      "fixContinuityCaptureHooks",
      "removeContinuityCaptureHooks",
      "fixSessionStartHook",
      "upgradeSessionStartHookCommand",
    ];
    for (const sink of sinks) {
      expect(functionBody(src, sink), `${sink} does not route through the primitive`).toContain("withConfigCriticalSection(");
    }

    // fixClaudeMdBootstrap is the ONLY remaining raw writeFileSync in the
    // module — it writes CLAUDE.md, which is not a hook config file.
    const rawWrites = [...src.matchAll(/writeFileSync\(/g)];
    expect(rawWrites.length, "expected exactly ONE raw writeFileSync in doctor-client.ts").toBe(1);
    expect(functionBody(src, "fixClaudeMdBootstrap")).toContain("writeFileSync(");
    for (const sink of sinks) {
      expect(functionBody(src, sink), `${sink} still carries a raw writeFileSync`).not.toContain("writeFileSync(");
    }
  });
});
