import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { resolveModelsDir } from "../../resources/embeddings-provider";

/**
 * resolveModelsDir() decides where the embeddings model lives / downloads.
 *
 * The whole point of ops-am0v: the chosen dir must ALWAYS be user-writable, so a
 * sudo/root-owned global install (package dir owned by root) never targets the
 * read-only package dir and silently kills semantic search.
 */
describe("resolveModelsDir (ops-am0v)", () => {
  const SAVED = {
    FLAIR_MODELS_DIR: process.env.FLAIR_MODELS_DIR,
    ROOTPATH: process.env.ROOTPATH,
  };
  let originalCwd: string;
  let scratch: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpath so comparisons against process.cwd() hold on macOS, where
    // /var and /tmp are symlinks to /private/* (cwd reports the resolved path).
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "flair-models-dir-")));
    delete process.env.FLAIR_MODELS_DIR;
    delete process.env.ROOTPATH;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (SAVED.FLAIR_MODELS_DIR === undefined) delete process.env.FLAIR_MODELS_DIR;
    else process.env.FLAIR_MODELS_DIR = SAVED.FLAIR_MODELS_DIR;
    if (SAVED.ROOTPATH === undefined) delete process.env.ROOTPATH;
    else process.env.ROOTPATH = SAVED.ROOTPATH;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("honors FLAIR_MODELS_DIR override above everything", () => {
    process.env.FLAIR_MODELS_DIR = "/opt/flair-models";
    process.env.ROOTPATH = "/some/data"; // present but lower priority
    expect(resolveModelsDir()).toBe("/opt/flair-models");
  });

  it("defaults to <ROOTPATH>/models — the writable Harper data dir Flair passes", () => {
    process.env.ROOTPATH = join(scratch, "data");
    // Even if a (stale) package-dir models existed, ROOTPATH wins over cwd.
    process.chdir(scratch);
    mkdirSync(join(scratch, "models"), { recursive: true });
    expect(resolveModelsDir()).toBe(join(scratch, "data", "models"));
  });

  it("falls back to <cwd>/models ONLY when a model is already cached there (backward compat)", () => {
    // No ROOTPATH (e.g. a non-Flair-spawned host), but a prior writable install
    // already downloaded into the package dir — reuse it, don't re-download.
    process.chdir(scratch);
    mkdirSync(join(scratch, "models"), { recursive: true });
    expect(resolveModelsDir()).toBe(join(scratch, "models"));
  });

  it("never returns the read-only package dir on a fresh install (no ROOTPATH, no cached model)", () => {
    // Fresh sudo-global install: cwd is the root-owned package dir with no
    // models/ subdir. Must resolve to a user-writable ~/.flair location, NOT cwd.
    process.chdir(scratch); // no models/ subdir exists here
    const resolved = resolveModelsDir();
    expect(resolved).toBe(join(homedir(), ".flair", "data", "models"));
    expect(resolved).not.toBe(join(scratch, "models"));
  });
});
