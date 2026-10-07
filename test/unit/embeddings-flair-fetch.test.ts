import { createHash } from "node:crypto";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import {
  classifyProbeError,
  ensureModelFile,
  type ModelDownloader,
} from "../../resources/embeddings/fetch.ts";
import { modelDownloadUrl, type EmbeddingModelEntry } from "../../resources/embeddings/models.ts";

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

  it("refuses a digest mismatch and does not replace the file", async () => {
    const dir = scratch();
    const entry = fixtureEntry(Buffer.from("abcd"));
    const bad = Buffer.from("abce");
    await writeFile(join(dir, entry.file), bad);
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: bodyFrom(Buffer.from("abcd")) };
    };
    await expect(ensureModelFile(entry, dir, { download })).rejects.toThrow(EmbeddingModelError);
    expect(called).toBe(false);
    expect(await readFile(join(dir, entry.file))).toEqual(bad);
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

  it("refuses a missing models directory and does not fetch", async () => {
    const dir = join(tmpdir(), `flair-embed-missing-${Date.now()}`);
    const entry = fixtureEntry(Buffer.from("abcd"));
    let called = false;
    const download: ModelDownloader = async () => {
      called = true;
      return { ok: true, status: 200, statusText: "OK", body: null };
    };
    const err = await ensureModelFile(entry, dir, { download }).then(() => {
      throw new Error("expected refusal");
    }, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("missing-dir");
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
});
