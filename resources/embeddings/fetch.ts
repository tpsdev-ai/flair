/**
 * Fetch a registry model into the models directory.
 *
 * The initial request URL is
 * `https://huggingface.co/<repo>/resolve/<revision>/<file>` (commit revision,
 * URL-encoded segments). The production downloader follows redirects. No
 * Hugging Face token is attached.
 *
 * One downloader holds `<file>.downloading` (exclusive create). Others wait.
 * A lock whose mtime is older than the stale window is reclaimed. Bytes go to
 * a unique temp in the models directory, are fsync'd, then renamed. The file
 * is verified by descriptor (O_NOFOLLOW, fstat regular file, size, SHA-256)
 * after rename. An existing mismatch is quarantined and fetched again, never
 * loaded. The models directory is created mode 0700 when absent. A symlink,
 * a foreign owner, or group/other write bits refuse the directory.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, unlink, utimes } from "node:fs/promises";
import { EmbeddingModelError } from "./errors.js";
import {
  assertResolvedModelPath,
  BUILTIN_EMBEDDING_MODEL,
  modelDownloadUrl,
  type EmbeddingModelEntry,
} from "./models.js";

export const LOCK_STALE_MS = 60_000;
export const DOWNLOAD_WAIT_TIMEOUT_MS = 300_000;
const POLL_MS = 50;

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

export interface DirFacts {
  uid: number;
  mode: number;
}

export interface EnsureModelOptions {
  download?: ModelDownloader;
  probe?: (path: string) => Promise<PathProbe>;
  hashFile?: (path: string, expectedBytes: number) => Promise<string>;
  pollMs?: number;
  waitTimeoutMs?: number;
  staleMs?: number;
  now?: () => number;
  /** Test seam: runs after rename and before the post-rename verify. */
  afterRename?: (dest: string) => Promise<void>;
  statDir?: (path: string) => Promise<DirFacts>;
  expectedUid?: number;
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
 * Re-verify a path immediately before native load. Checks the containing
 * directory, then the bytes through an O_NOFOLLOW descriptor.
 */
export async function reverifyBeforeLoad(
  entry: EmbeddingModelEntry,
  modelPath: string,
  opts: EnsureModelOptions = {},
): Promise<void> {
  const dir = modelPath.slice(0, modelPath.length - entry.file.length - 1);
  await prepareModelsDir(dir, opts);
  const hashFile = opts.hashFile ?? sha256File;
  const probe = opts.probe ?? probeModelPath;
  const found = await probe(modelPath);
  await assertVerified(entry, modelPath, found, hashFile);
}

export async function verifyExistingModelFile(
  entry: EmbeddingModelEntry,
  modelPath: string,
  opts: EnsureModelOptions = {},
): Promise<string> {
  await reverifyBeforeLoad(entry, modelPath, opts);
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
  await prepareModelsDir(modelsDir, opts);
  const dest = assertResolvedModelPath(modelsDir, entry.file);

  const existing = await probe(dest);
  if (existing.state === "file") {
    try {
      await assertVerified(entry, dest, existing, hashFile);
      return dest;
    } catch (err) {
      if (!(err instanceof EmbeddingModelError) || err.code !== "digest-mismatch") throw err;
      await quarantine(dest, entry.file, modelsDir);
    }
  } else if (existing.state !== "absent") {
    refuseProbe(dest, existing);
  }

  await withDownloadLock(dest, modelsDir, entry.file, opts, async () => {
    const again = await probe(dest);
    if (again.state === "file") {
      try {
        await assertVerified(entry, dest, again, hashFile);
        return;
      } catch (err) {
        if (!(err instanceof EmbeddingModelError) || err.code !== "digest-mismatch") throw err;
        await quarantine(dest, entry.file, modelsDir);
      }
    } else if (again.state !== "absent") {
      refuseProbe(dest, again);
    }
    const tmp = assertResolvedModelPath(modelsDir, `${entry.file}.${randomBytes(8).toString("hex")}.partial`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      await writeDownload(handle, url, entry, download, opts, dest + ".downloading");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, dest);
      if (opts.afterRename) await opts.afterRename(dest);
    } catch (err) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    await assertVerified(entry, dest, { state: "file", size: entry.bytes }, hashFile);
  });
  await assertVerified(entry, dest, { state: "file", size: entry.bytes }, hashFile);
  return dest;
}

export async function prepareModelsDir(modelsDir: string, opts: EnsureModelOptions = {}): Promise<void> {
  let existed = true;
  try {
    const before = await lstat(modelsDir);
    if (before.isSymbolicLink()) {
      throw new EmbeddingModelError(
        "symlink",
        `[embeddings] models directory ${modelsDir} is a symlink.`,
        "Use a real directory. Refusing to follow a symlink.",
      );
    }
  } catch (err) {
    if (err instanceof EmbeddingModelError) throw err;
    if (errorCode(err) !== "ENOENT") {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] models directory ${modelsDir} is unreadable (${errorCode(err) ?? "unknown"}).`,
        "Fix permissions on the models directory. Refusing to treat an unreadable directory as missing.",
      );
    }
    existed = false;
  }
  if (!existed) {
    await mkdir(modelsDir, { recursive: true, mode: 0o700 });
    await chmod(modelsDir, 0o700);
  }
  const facts = opts.statDir
    ? await opts.statDir(modelsDir)
    : await stat(modelsDir).then((st) => ({ uid: st.uid, mode: st.mode }));
  const uid = opts.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : facts.uid);
  if (facts.uid !== uid) {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] models directory ${modelsDir} is owned by uid ${facts.uid}, not ${uid}.`,
      "Use a directory owned by the user running Flair. Refusing to load.",
    );
  }
  if ((facts.mode & 0o022) !== 0) {
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] models directory ${modelsDir} is group or other writable (mode ${(facts.mode & 0o777).toString(8)}).`,
      "Use mode 0700. Refusing to load from a directory other users can write.",
    );
  }
}

async function withDownloadLock(
  dest: string,
  modelsDir: string,
  file: string,
  opts: EnsureModelOptions,
  run: () => Promise<void>,
): Promise<void> {
  const lockPath = assertResolvedModelPath(modelsDir, `${file}.downloading`);
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const waitMs = opts.waitTimeoutMs ?? DOWNLOAD_WAIT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  while (true) {
    await reclaimStaleLock(lockPath, staleMs, now);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        throw new EmbeddingModelError(
          "unreadable",
          `[embeddings] could not create download lock ${lockPath} (${errorCode(err) ?? "unknown"}).`,
          "Fix permissions on the models directory. Refusing to write elsewhere.",
        );
      }
      const outcome = await waitForDownload(dest, lockPath, deadline, opts);
      if (outcome === "complete") return;
      continue;
    }
    try {
      await lock.close();
      await run();
      return;
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function reclaimStaleLock(lockPath: string, staleMs: number, now: () => number): Promise<void> {
  try {
    const st = await lstat(lockPath);
    if (st.isSymbolicLink()) {
      throw new EmbeddingModelError(
        "symlink",
        `[embeddings] download lock ${lockPath} is a symlink.`,
        "Remove the symlink. Refusing to follow it.",
      );
    }
    if (now() - st.mtimeMs > staleMs) await unlink(lockPath);
  } catch (err) {
    if (err instanceof EmbeddingModelError) throw err;
    if (errorCode(err) === "ENOENT") return;
  }
}

async function waitForDownload(
  dest: string,
  lockPath: string,
  deadline: number,
  opts: EnsureModelOptions,
): Promise<"complete" | "retry"> {
  const poll = opts.pollMs ?? POLL_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probeModelPath;
  while (true) {
    const found = await probe(dest);
    if (found.state === "file") return "complete";
    let lockAlive = false;
    try {
      const st = await lstat(lockPath);
      lockAlive = now() - st.mtimeMs <= staleMs;
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        const after = await probe(dest);
        return after.state === "file" ? "complete" : "retry";
      }
    }
    if (!lockAlive) return "retry";
    if (now() > deadline) {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] timed out waiting for ${dest}.`,
        "Retry the download. Refusing to load a file another downloader did not finish.",
      );
    }
    await sleep(poll);
  }
}

async function writeDownload(
  handle: Awaited<ReturnType<typeof open>>,
  url: string,
  entry: EmbeddingModelEntry,
  download: ModelDownloader,
  opts: EnsureModelOptions,
  lockPath: string,
): Promise<void> {
  const response = await download(url);
  if (!response.ok) {
    throw new EmbeddingModelError(
      "truncated",
      `[embeddings] download of ${url} failed with HTTP ${response.status} ${response.statusText}.`,
      "Retry when the pinned revision is served. The partial file was removed. Refusing to load.",
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
  const now = opts.now ?? Date.now;
  let lastTouch = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (value == null || value.byteLength === 0) continue;
      hash.update(value);
      await writeAll(handle, value);
      total += value.byteLength;
      const t = now();
      if (t - lastTouch > 1000) {
        const stamp = new Date(t);
        await utimes(lockPath, stamp, stamp).catch(() => undefined);
        lastTouch = t;
      }
    }
  } catch (err) {
    if (err instanceof EmbeddingModelError) throw err;
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
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new EmbeddingModelError(
        "truncated",
        `[embeddings] a download write made no progress at offset ${offset}.`,
        "Retry the download. Refusing to load a short file.",
      );
    }
    offset += bytesWritten;
  }
}

async function quarantine(dest: string, file: string, modelsDir: string): Promise<void> {
  const name = `${file}.quarantine-${randomBytes(4).toString("hex")}`;
  const parked = assertResolvedModelPath(modelsDir, name);
  await rename(dest, parked);
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
      `Quarantine ${path} and retry so the pinned file can be fetched. Refusing to load it.`,
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
      `Quarantine ${path} and retry. Refusing to load a mismatched file.`,
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
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new EmbeddingModelError(
        "not-file",
        `[embeddings] ${path} is not a regular file on the opened descriptor.`,
        "Replace it with the registry file. Refusing to load.",
      );
    }
    if (st.size !== expectedBytes) {
      throw new EmbeddingModelError(
        "digest-mismatch",
        `[embeddings] ${path} is ${st.size} bytes on the opened descriptor; expected ${expectedBytes}.`,
        "Replace the file with the registry blob. Refusing to load.",
      );
    }
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

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = Reflect.get(err, "code");
  return typeof code === "string" ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
