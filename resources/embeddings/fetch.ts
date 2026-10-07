/**
 * Fetch a registry model into the models directory.
 *
 * Download URL is only `https://huggingface.co/<repo>/resolve/<revision>/<file>`
 * with a commit revision. Bytes land in a temp file in that directory, are
 * checked for size and SHA-256, then renamed into place. An existing file is
 * re-verified before use. A mismatch, a short read, a symlink, or an
 * unreadable probe refuses — nothing unverified is loaded, and a failed probe
 * is not treated as "absent".
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { EmbeddingModelError } from "./errors.js";
import {
  BUILTIN_EMBEDDING_MODEL,
  modelDownloadUrl,
  type EmbeddingModelEntry,
} from "./models.js";

export type PathProbe =
  | { state: "absent" }
  | { state: "symlink" }
  | { state: "directory" }
  | { state: "not-file" }
  | { state: "file"; size: number }
  | { state: "unreadable"; code: string };

export interface ModelDownloadResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
}

export type ModelDownloader = (url: string) => Promise<ModelDownloadResponse>;

export interface EnsureModelOptions {
  download?: ModelDownloader;
  probe?: (path: string) => Promise<PathProbe>;
  hashFile?: (path: string, expectedBytes: number) => Promise<string>;
}

export function classifyProbeError(err: unknown): "absent" | "unreadable" {
  return errorCode(err) === "ENOENT" ? "absent" : "unreadable";
}

export async function probeModelPath(path: string): Promise<PathProbe> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return { state: "symlink" };
    if (st.isDirectory()) return { state: "directory" };
    if (st.isFile()) return { state: "file", size: st.size };
    return { state: "not-file" };
  } catch (err) {
    const kind = classifyProbeError(err);
    if (kind === "absent") return { state: "absent" };
    return { state: "unreadable", code: errorCode(err) ?? "unknown" };
  }
}

export async function ensureBuiltinModelFile(
  modelsDir: string,
  opts: EnsureModelOptions = {},
): Promise<string> {
  return ensureModelFile(BUILTIN_EMBEDDING_MODEL, modelsDir, opts);
}

/**
 * Re-verify a caller-supplied path against the registry. Does not download.
 * A missing path is unreadable, not a cue to fetch.
 */
export async function verifyExistingModelFile(
  entry: EmbeddingModelEntry,
  modelPath: string,
  opts: EnsureModelOptions = {},
): Promise<string> {
  const probe = opts.probe ?? probeModelPath;
  const hashFile = opts.hashFile ?? sha256File;
  const found = await probe(modelPath);
  if (found.state === "absent") {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model path ${modelPath} is not present.`,
      "Point FLAIR_RECALL_HARNESS_MODEL_PATH at the registry file. Refusing to download to a caller-supplied path.",
    );
  }
  await assertVerified(entry, modelPath, found, hashFile);
  return modelPath;
}

export async function ensureModelFile(
  entry: EmbeddingModelEntry,
  modelsDir: string,
  opts: EnsureModelOptions = {},
): Promise<string> {
  const url = modelDownloadUrl(entry);
  const probe = opts.probe ?? probeModelPath;
  const hashFile = opts.hashFile ?? sha256File;
  const download = opts.download ?? downloadWithFetch;

  const dirProbe = await probe(modelsDir);
  if (dirProbe.state === "absent") {
    throw new EmbeddingModelError(
      "missing-dir",
      `[embeddings] models directory ${modelsDir} does not exist.`,
      `Create ${modelsDir} and retry. Refusing to create it or to load a model.`,
    );
  }
  if (dirProbe.state !== "directory") {
    if (dirProbe.state === "symlink") {
      throw new EmbeddingModelError(
        "symlink",
        `[embeddings] models directory ${modelsDir} is a symlink.`,
        "Use a real directory. Refusing to follow a symlink.",
      );
    }
    if (dirProbe.state === "unreadable") {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] models directory ${modelsDir} is unreadable (${dirProbe.code}).`,
        "Fix permissions on the models directory. Refusing to treat an unreadable directory as missing.",
      );
    }
    throw new EmbeddingModelError(
      "not-file",
      `[embeddings] models path ${modelsDir} is not a directory (${dirProbe.state}).`,
      "Point FLAIR_MODELS_DIR at a real directory. Refusing to load.",
    );
  }

  const dest = destinationPath(modelsDir, entry.file);
  const existing = await probe(dest);
  if (existing.state === "file") {
    await assertVerified(entry, dest, existing, hashFile);
    return dest;
  }
  if (existing.state !== "absent") {
    refuseProbe(dest, existing);
  }

  const tmp = destinationPath(modelsDir, `${entry.file}.${randomBytes(8).toString("hex")}.partial`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    } catch (err) {
      const code = errorCode(err);
      if (code === "ELOOP" || code === "EEXIST") {
        throw new EmbeddingModelError(
          "symlink",
          `[embeddings] temp path ${tmp} already exists or is a symlink.`,
          "Remove the symlink in the models directory and retry. Refusing to follow it.",
        );
      }
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] could not create a temp file in ${modelsDir} (${code ?? "unknown"}).`,
        "Fix permissions on the models directory. Refusing to write elsewhere.",
      );
    }
    const response = await download(url);
    if (!response.ok) {
      throw new EmbeddingModelError(
        "truncated",
        `[embeddings] download of ${url} failed with HTTP ${response.status} ${response.statusText}.`,
        "Retry when Hugging Face serves the pinned revision. The partial file was removed. Refusing to load.",
      );
    }
    if (response.body == null) {
      throw new EmbeddingModelError(
        "empty-body",
        `[embeddings] download of ${url} returned an empty body.`,
        "Retry the download. An empty body is not a model file. Refusing to load.",
      );
    }
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const value = step.value;
        if (value == null || value.byteLength === 0) continue;
        hash.update(value);
        await handle.write(value);
        total += value.byteLength;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] download of ${url} could not be read (${detail}).`,
        "Retry the download. An unreadable body is not a successful fetch. Refusing to load.",
      );
    }
    if (total !== entry.bytes) {
      throw new EmbeddingModelError(
        "truncated",
        `[embeddings] download of ${entry.file} wrote ${total} bytes; the registry records ${entry.bytes}.`,
        "Retry the download. The partial file was removed. Refusing to load a short file.",
      );
    }
    const digest = hash.digest("hex");
    if (digest !== entry.sha256) {
      throw new EmbeddingModelError(
        "digest-mismatch",
        `[embeddings] download of ${entry.file} hashed ${digest}; the registry records ${entry.sha256}.`,
        "Retry the download. The partial file was removed. Refusing to load a mismatched file.",
      );
    }
    await handle.close();
    handle = undefined;
    const again = await probe(dest);
    if (again.state === "file") {
      await assertVerified(entry, dest, again, hashFile);
      await unlink(tmp).catch(() => undefined);
      return dest;
    }
    if (again.state !== "absent") {
      await unlink(tmp).catch(() => undefined);
      refuseProbe(dest, again);
    }
    await rename(tmp, dest);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await assertVerified(entry, dest, { state: "file", size: entry.bytes }, hashFile);
  return dest;
}

async function assertVerified(
  entry: EmbeddingModelEntry,
  path: string,
  probe: PathProbe,
  hashFile: (path: string, expectedBytes: number) => Promise<string>,
): Promise<void> {
  if (probe.state === "symlink") {
    throw new EmbeddingModelError(
      "symlink",
      `[embeddings] model path ${path} is a symlink.`,
      "Replace the symlink with the registry file. Refusing to follow it.",
    );
  }
  if (probe.state === "unreadable") {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model path ${path} is unreadable (${probe.code}).`,
      "Fix permissions or replace the file. Refusing to treat an unreadable file as missing.",
    );
  }
  if (probe.state !== "file") {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model path ${path} is not a regular file (${probe.state}).`,
      "Put the registry file at that path. Refusing to load.",
    );
  }
  if (probe.size !== entry.bytes) {
    throw new EmbeddingModelError(
      "digest-mismatch",
      `[embeddings] ${path} is ${probe.size} bytes; the registry records ${entry.bytes}.`,
      `Remove ${path} and retry so the pinned file can be fetched. Refusing to load or replace it.`,
    );
  }
  let digest: string;
  try {
    digest = await hashFile(path, entry.bytes);
  } catch (err) {
    if (err instanceof EmbeddingModelError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] could not hash ${path} (${detail}).`,
      "Fix permissions on the model file. Refusing to load an unverified file.",
    );
  }
  if (digest !== entry.sha256) {
    throw new EmbeddingModelError(
      "digest-mismatch",
      `[embeddings] ${path} hashed ${digest}; the registry records ${entry.sha256}.`,
      `Remove ${path} and retry. Refusing to load a mismatched file.`,
    );
  }
}

function refuseProbe(path: string, probe: PathProbe): never {
  if (probe.state === "symlink") {
    throw new EmbeddingModelError(
      "symlink",
      `[embeddings] model path ${path} is a symlink.`,
      "Replace the symlink with the registry file. Refusing to follow it.",
    );
  }
  if (probe.state === "unreadable") {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model path ${path} is unreadable (${probe.code}).`,
      "Fix permissions or replace the file. Refusing to treat an unreadable file as missing.",
    );
  }
  throw new EmbeddingModelError(
    "not-file",
    `[embeddings] model path ${path} is not a regular file.`,
    "Remove it and retry. Refusing to load.",
  );
}

export async function sha256File(path: string, expectedBytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ELOOP") {
      throw new EmbeddingModelError(
        "symlink",
        `[embeddings] model path ${path} is a symlink.`,
        "Replace the symlink with the registry file. Refusing to follow it.",
      );
    }
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model path ${path} could not be read (${code ?? "unknown"}).`,
      "Fix permissions on the model file. Refusing to load an unverified file.",
    );
  }
  try {
    const hash = createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (total < expectedBytes) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total !== expectedBytes) {
      throw new EmbeddingModelError(
        "truncated",
        `[embeddings] ${path} read ${total} bytes; expected ${expectedBytes}.`,
        "Replace the file with the registry blob. Refusing to load a short read.",
      );
    }
    const extra = await handle.read(buf, 0, 1, total);
    if (extra.bytesRead !== 0) {
      throw new EmbeddingModelError(
        "digest-mismatch",
        `[embeddings] ${path} is longer than the registry byte count ${expectedBytes}.`,
        "Remove the file and retry. Refusing to load it.",
      );
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function downloadWithFetch(url: string): Promise<ModelDownloadResponse> {
  const response = await fetch(url, { redirect: "follow" });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: response.body,
  };
}

function destinationPath(modelsDir: string, file: string): string {
  if (file.includes("/") || file.includes("\\") || file.includes("\0") || file === "." || file === "..") {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] refusing to write ${JSON.stringify(file)} — it is not a single path segment.`,
      "Fix the registry file name.",
    );
  }
  const root = resolve(modelsDir);
  const dest = resolve(root, file);
  const rel = relative(root, dest);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new EmbeddingModelError(
      "bad-registry-path",
      `[embeddings] refusing to write outside ${root}.`,
      "Fix the models directory and the registry file name.",
    );
  }
  return dest;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
