import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShareDocument, writeShareDocument } from "../src/share.js";
import type { HostFingerprint, ModelBenchResult } from "../src/types.js";

const host: HostFingerprint = {
  label: "my-test-rig",
  platform: "linux",
  arch: "x64",
  cpuModel: "Some CPU",
  totalRamGiB: 64,
  availableRamGiB: 40,
  backend: "cuda",
  gpuDeviceNames: ["NVIDIA H100"],
};

const model: ModelBenchResult = {
  model: {
    fileName: "nomic-embed-text-v1.5.Q4_K_M.gguf",
    sha256: "b".repeat(64),
    sizeBytes: 84_106_624,
    quant: "Q4_K_M",
    quantSource: "gguf-metadata",
    dims: 768,
    paramsApprox: 137_000_000,
    bpw: 4.9,
  },
  loadTimeMs: 812.3,
  msPerEmbedSerialWarm: 18.4,
  peakRssDeltaMiB: 612.1,
  aggregate: { n: 126, p3: 0.976, mrr: 0.946 },
  perKind: {
    stress: { n: 17, p3: 0.9, mrr: 0.96 },
    trap: { n: 34, p3: 0.9, mrr: 0.93 },
    hard: { n: 46, p3: 0.9, mrr: 0.95 },
    clean: { n: 29, p3: 0.9, mrr: 0.96 },
  },
};

// The absolute-path prefix a real machine's paths would carry — used to
// prove none of it leaks into the document, even though the fixture
// ModelIdentity above is deliberately basename-only (this guards against a
// FUTURE regression where someone starts passing the full path through).
const FORBIDDEN_PATH_HINT = "/Users/";
const FORBIDDEN_HOME_HINT = "/home/";

describe("buildShareDocument", () => {
  const doc = buildShareDocument(model, host);

  test("carries only a basename, never a path, for the model file", () => {
    expect(doc.model.fileBasename).toBe("nomic-embed-text-v1.5.Q4_K_M.gguf");
    expect(doc.model.fileBasename).not.toContain("/");
    expect(doc.model.fileBasename).not.toContain("\\");
  });

  test("derives a clean model name without the quant suffix", () => {
    expect(doc.model.name).toBe("nomic-embed-text-v1.5");
  });

  test("carries the measured numbers verbatim", () => {
    expect(doc.results.aggregate).toEqual(model.aggregate);
    expect(doc.results.perKind).toEqual(model.perKind);
  });

  test("hardware.label is the freeform label, not an auto-filled hostname", () => {
    expect(doc.hardware.label).toBe("my-test-rig");
  });

  test("no forbidden field names present anywhere in the schema", () => {
    const json = JSON.stringify(doc);
    for (const forbidden of ["hostname", "username", "userInfo", "homedir", "cwd", "process.env"]) {
      expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("no absolute filesystem path anywhere in the serialized document", () => {
    const json = JSON.stringify(doc);
    expect(json).not.toContain(FORBIDDEN_PATH_HINT);
    expect(json).not.toContain(FORBIDDEN_HOME_HINT);
  });

  test("gpu is null when no GPU device names are present (cpu backend)", () => {
    const cpuHost: HostFingerprint = { ...host, backend: "cpu", gpuDeviceNames: [] };
    const cpuDoc = buildShareDocument(model, cpuHost);
    expect(cpuDoc.hardware.gpu).toBeNull();
  });

  test("gpu is a joined device string when present", () => {
    expect(doc.hardware.gpu).toBe("NVIDIA H100");
  });

  test("label is omitted (undefined), not an empty string, when the caller passed none", () => {
    const noLabelHost: HostFingerprint = { ...host, label: undefined };
    const noLabelDoc = buildShareDocument(model, noLabelHost);
    expect(noLabelDoc.hardware.label).toBeUndefined();
  });
});

describe("writeShareDocument", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("writes a file and reports where, without configuring a live endpoint", () => {
    dir = mkdtempSync(join(tmpdir(), "flair-bench-share-test-"));
    const doc = buildShareDocument(model, host);
    const written = writeShareDocument(doc, dir);
    expect(written.filePath.startsWith(dir)).toBe(true);
    expect(written.endpointNote).toContain("submission endpoint not yet configured");

    const onDisk = JSON.parse(readFileSync(written.filePath, "utf8"));
    expect(onDisk.model.fileBasename).toBe("nomic-embed-text-v1.5.Q4_K_M.gguf");
  });
});
