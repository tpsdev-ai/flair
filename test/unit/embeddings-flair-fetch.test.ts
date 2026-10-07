import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import { degradeForActivationFailure } from "../../resources/embeddings/degrade.ts";
import {
  classifyProbeError,
  ensureModelFile,
  prepareModelsDir,
  sha256File,
  type ModelDownloader,
} from "../../resources/embeddings/fetch.ts";
import {
  assertResolvedModelPath,
  buildModelDownloadUrl,
  BUILTIN_EMBEDDING_MODEL,
  modelDownloadUrl,
  type EmbeddingModelEntry,
} from "../../resources/embeddings/models.ts";

function fixtureEntry(bytes: Buffer): EmbeddingModelEntry {
  return {
    id: "fixture",
    repo: "example/model",
    revision: "0123456789abcdef0123456789abcdef01234567",
    file: "fixture.gguf",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dims: 4,
    pooling: "mean",
    templates: {
      document: "search_document: {text}",
      query: "search_query: {text}",
    },
  };
}

function bodyFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function scratch(): string {
  return tempDir("flair-embed-fetch-");
}

function writeFrozenId(entry: { id: string }, next: string): void {
  entry.id = next;
}

describe("embeddings fetch (S1 verified model file)", () => {
  it("refuses a branch name and a path that leaves the models directory", () => {
    const entry = fixtureEntry(Buffer.from("abcd"));
    expect(() => modelDownloadUrl({ ...entry, revision: "main" })).toThrow(/commit/);
    expect(() => modelDownloadUrl({ ...entry, file: "../evil.gguf" })).toThrow(/path segment/);
    expect(() => modelDownloadUrl({ ...entry, repo: "https://evil.example/x" })).toThrow(/owner\/name/);
  });

  it("classifies a non-ENOENT probe as unreadable, never absent", () => {
    expect(classifyProbeError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe("absent");
    expect(classifyProbeError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("unreadable");
    expect(classifyProbeError(new Error("no code"))).toBe("unreadable");
    expect(classifyProbeError("EACCES")).toBe("unreadable");
  });

  it("does not download when the verified file is already present", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    await writeFile(join(dir, entry.file), bytes);
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
    };
    const path = await ensureModelFile(entry, dir, { download });
    expect(path).toBe(join(dir, entry.file));
    expect(called).toBe(false);
  }, 10_000);

  it("quarantines a digest mismatch and fetches a replacement", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const bad = Buffer.from("abce");
    await writeFile(join(dir, entry.file), bad);
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
    };
    const path = await ensureModelFile(entry, dir, { download });
    expect(called).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from("abcd"));
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith(`${entry.file}.quarantine-`))).toBe(true);
  }, 10_000);

  it("refuses an unreadable file without treating it as absent", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
    };
    await expect(ensureModelFile(entry, dir, {
      download,
      probe: async (path) => path === dir
        ? { state: "directory" }
        : { state: "unreadable", code: "EACCES" },
    })).rejects.toThrow(/unreadable/);
    expect(called).toBe(false);
  }, 10_000);

  it("creates a missing models directory at mode 0700 and then fetches", async () => {
    const parent = scratch();
    const dir = join(parent, "models");
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
    };
    const path = await ensureModelFile(entry, dir, { download });
    expect(called).toBe(true);
    expect(path).toBe(join(dir, entry.file));
    const st = await lstat(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  }, 10_000);

  it("refuses a group-writable models directory and does not fetch", async () => {
    const dir = scratch();
    await chmod(dir, 0o777);
    const entry = fixtureEntry(Buffer.from("abcd"));
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
    };
    const err = await ensureModelFile(entry, dir, { download }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.message).toMatch(/group or other writable/);
    expect(called).toBe(false);
  }, 10_000);

  it("refuses a symlink at the destination and does not write through it", async () => {
    const dir = scratch();
    const outside = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const sentinel = Buffer.from("sentinel-bytes");
    const outsideFile = join(outside, "secret");
    await writeFile(outsideFile, sentinel);
    await symlink(outsideFile, join(dir, entry.file));
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
    };
    await expect(ensureModelFile(entry, dir, { download })).rejects.toThrow(/symlink/);
    expect(called).toBe(false);
    expect(await readFile(outsideFile)).toEqual(sentinel);
    const st = await lstat(join(dir, entry.file));
    expect(st.isSymbolicLink()).toBe(true);
  }, 10_000);

  it("refuses a truncated download and leaves no model file", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const download: ModelDownloader = async (url) => {
      expect(url).toBe(modelDownloadUrl(entry));
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("ab")) };
    };
    const err = await ensureModelFile(entry, dir, { download }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("truncated");
    await expect(lstat(join(dir, entry.file))).rejects.toThrow();
  }, 10_000);

  it("refuses an empty download body", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const download: ModelDownloader = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: null,
    });
    const err = await ensureModelFile(entry, dir, { download }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("empty-body");
    await expect(lstat(join(dir, entry.file))).rejects.toThrow();
  }, 10_000);

  it("stores a download that matches the registry and re-verifies it", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const download: ModelDownloader = async (url) => {
      expect(url).toBe(
        "https://huggingface.co/example/model/resolve/0123456789abcdef0123456789abcdef01234567/fixture.gguf",
      );
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
    };
    const path = await ensureModelFile(entry, dir, { download });
    expect(await readFile(path)).toEqual(bytes);
    let called = false;
    const again = await ensureModelFile(entry, dir, {
      download: async () => {
        called = true;
        return { ok: false, status: 500, statusText: "no", body: null };
      },
    });
    expect(again).toBe(path);
    expect(called).toBe(false);
  }, 10_000);

  it("lets one downloader win and the waiter reuse the file", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    let calls = 0;
    const download: ModelDownloader = async () => {
      calls += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
    };
    const [a, b] = await Promise.all([
      ensureModelFile(entry, dir, { download }),
      ensureModelFile(entry, dir, { download }),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  }, 10_000);

  it("does not let two stale-lock reclaimers both download", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    await writeFile(lock, "stale-owner");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    let calls = 0;
    const download: ModelDownloader = async () => {
      calls += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
    };
    const [a, b] = await Promise.all([
      ensureModelFile(entry, dir, { download, staleMs: 1_000 }),
      ensureModelFile(entry, dir, { download, staleMs: 1_000 }),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  }, 10_000);

  it("does not unlink a successor lock that replaced the stale one", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    await writeFile(lock, "stale-owner");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    const successor = "successor-token-0123456789abcdef";
    let calls = 0;
    const err = await ensureModelFile(entry, dir, {
      staleMs: 1_000,
      waitTimeoutMs: 400,
      pollMs: 20,
      beforeReclaimUnlink: async (lockPath) => {
        await unlink(lockPath);
        await writeFile(lockPath, successor);
      },
      download: async () => {
        calls += 1;
        return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.message).toMatch(/timed out/);
    expect(calls).toBe(0);
    expect(await readFile(lock, "utf8")).toBe(successor);
  }, 10_000);

  it("heartbeats a stalled read so a waiter does not start a second download", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const download: ModelDownloader = async () => {
      const mine = ++calls;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (mine === 1) await gate;
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return { ok: true, status: 200, statusText: "OK", body };
    };
    const first = ensureModelFile(entry, dir, { download, staleMs: 300, pollMs: 20 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const second = ensureModelFile(entry, dir, { download, staleMs: 300, pollMs: 20 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  }, 10_000);

  it("reclaims a stale downloading lock and fetches", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    await writeFile(lock, "");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    let called = false;
    const path = await ensureModelFile(entry, dir, {
      download: async () => {
        called = true;
        return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
      },
    });
    expect(called).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    await expect(lstat(lock)).rejects.toThrow();
  }, 10_000);

  it("refuses a foreign-owned models directory and does not fetch", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    let called = false;
    const err = await ensureModelFile(entry, dir, {
      download: async () => {
        called = true;
        return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
      },
      statDir: async () => ({ uid: 1, mode: 0o700 }),
      expectedUid: 0,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.message).toMatch(/owned by uid 1/);
    expect(called).toBe(false);
  }, 10_000);

  it("rejects a file altered after rename", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const err = await ensureModelFile(entry, dir, {
      download: async () => ({ ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) }),
      afterRename: async (dest) => {
        await writeFile(dest, Buffer.from("zzzz"));
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("digest-mismatch");
  }, 10_000);

  it("refuses to hash a directory as a model file", async () => {
    const dir = scratch();
    const nested = join(dir, "not-a-file");
    await mkdir(nested);
    const err = await sha256File(nested, 1).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("not-file");
  }, 10_000);

  it("freezes the registry and rejects path escape in the resolved file", () => {
    expect(Object.isFrozen(BUILTIN_EMBEDDING_MODEL)).toBe(true);
    expect(Object.isFrozen(BUILTIN_EMBEDDING_MODEL.templates)).toBe(true);
    expect(() => writeFrozenId(BUILTIN_EMBEDDING_MODEL, "changed")).toThrow(TypeError);
    const dir = scratch();
    expect(assertResolvedModelPath(dir, "fixture.gguf")).toBe(join(dir, "fixture.gguf"));
    expect(() => assertResolvedModelPath(dir, "../evil.gguf")).toThrow(/path segment/);
    expect(() => assertResolvedModelPath(dir, "nested/file.gguf")).toThrow(/path segment/);
    expect(() => modelDownloadUrl({ ...fixtureEntry(Buffer.from("abcd")), file: "a/../../x.gguf" })).toThrow(/path segment/);
    expect(buildModelDownloadUrl("o", "n", "abc", "a b.gguf")).toContain("a%20b.gguf");
  });

  it("wraps a downloader that rejects as a model-file error", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const err = await ensureModelFile(entry, dir, {
      download: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (!(err instanceof EmbeddingModelError)) return;
    expect(err.code).toBe("unreadable");
    expect(err.message).toContain("ECONNREFUSED");
    const recorded = degradeForActivationFailure(err);
    expect(recorded.message).toContain("could not be verified or fetched");
    expect(recorded.message).not.toContain("embeddings did not start");
    expect(recorded.message).not.toContain("did not load");
  }, 10_000);

  it("wraps mkdir when the models directory cannot be created", async () => {
    const dir = scratch();
    const parent = join(dir, "locked");
    await mkdir(parent, { mode: 0o500 });
    try {
      const err = await prepareModelsDir(join(parent, "models")).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingModelError);
      if (!(err instanceof EmbeddingModelError)) return;
      expect(err.code).toBe("unreadable");
      expect(err.message).toContain("could not create");
      expect(err.message).toContain("EACCES");
      const recorded = degradeForActivationFailure(err);
      expect(recorded.message).toContain("could not be verified or fetched");
      expect(recorded.message).not.toContain("embeddings did not start");
    } finally {
      await chmod(parent, 0o700);
    }
  }, 10_000);

  it("wraps a models directory whose parent is a file", async () => {
    const dir = scratch();
    const parent = join(dir, "not-a-directory");
    await writeFile(parent, "x");
    const err = await prepareModelsDir(join(parent, "models")).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (!(err instanceof EmbeddingModelError)) return;
    expect(err.code).toBe("unreadable");
    expect(err.message).toContain("ENOTDIR");
    const recorded = degradeForActivationFailure(err);
    expect(recorded.message).toContain("could not be verified or fetched");
    expect(recorded.message).not.toContain("embeddings did not start");
  }, 10_000);

  it("wraps a stat of the models directory that rejects", async () => {
    const dir = scratch();
    const err = await prepareModelsDir(dir, {
      statDir: async () => {
        throw Object.assign(new Error("stat failed"), { code: "EIO" });
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (!(err instanceof EmbeddingModelError)) return;
    expect(err.code).toBe("unreadable");
    expect(err.message).toContain("EIO");
    const recorded = degradeForActivationFailure(err);
    expect(recorded.message).toContain("could not be verified or fetched");
    expect(recorded.message).not.toContain("embeddings did not start");
  }, 10_000);

  // These three children replace the path before the final lstat. They do
  // not cover a replacement between that lstat and unlinkSync.
  it("leaves a child-process successor installed before the final release check", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    const successor = "successor-release-token";
    const path = await ensureModelFile(entry, dir, {
      download: async () => ({ ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) }),
      beforeReleaseUnlink: (lockPath) => replaceWithChild(dir, lockPath, successor),
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(lock, "utf8")).toBe(successor);
  }, 10_000);

  it("leaves a child-process successor installed before the final acquisition check", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    const successor = "successor-acquire-token";
    let calls = 0;
    const err = await ensureModelFile(entry, dir, {
      afterLockCreate: async () => {
        throw new Error("acquire-boom");
      },
      beforeAcquireCleanup: (lockPath) => replaceWithChild(dir, lockPath, successor),
      download: async () => {
        calls += 1;
        return { ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) };
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (err instanceof Error) expect(err.message).toContain("acquire-boom");
    expect(calls).toBe(0);
    expect(await readFile(lock, "utf8")).toBe(successor);
  }, 10_000);

  it("leaves a child-process successor installed before the final claim check", async () => {
    const dir = scratch();
    const bytes = Buffer.from("abcd");
    const entry = fixtureEntry(bytes);
    const lock = join(dir, `${entry.file}.downloading`);
    await writeFile(lock, "stale-owner");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    const stale = await lstat(lock);
    const claim = `${lock}.claim-${stale.ino}`;
    const successor = "successor-claim-token";
    const path = await ensureModelFile(entry, dir, {
      download: async () => ({ ok: true, status: 200, statusText: "OK", body: bodyFrom(bytes) }),
      beforeClaimCleanup: (claimPath) => replaceWithChild(dir, claimPath, successor),
    });
    expect(path).toBe(join(dir, entry.file));
    expect(await readFile(claim, "utf8")).toBe(successor);
  }, 10_000);
});

function replaceWithChild(dir: string, target: string, contents: string): Promise<void> {
  const script = join(dir, `replace-lock-${contents.length}.mjs`);
  writeFileSync(script, `
    import { unlinkSync, writeFileSync } from "node:fs";
    const target = process.argv[2];
    const contents = process.argv[3];
    try { unlinkSync(target); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    writeFileSync(target, contents);
  `);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, target, contents], { timeout: 10_000 });
    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`replacer exited ${code}: ${stderr}`));
    });
  });
}
