/**
 * share.ts — canonical share-JSON schema + local write.
 *
 * PRIVACY CONTRACT: the document built here MUST NEVER contain a hostname,
 * filesystem path, or username. `model.fileBasename` is a basename (see
 * ModelIdentity.fileName's own doc — never the full path); `hardware.label`
 * is a freeform string the CALLER chose (see types.ts's HostFingerprint —
 * defaults to nothing, never auto-filled from os.hostname()). See
 * test/share-schema.test.ts for the automated forbidden-field check this
 * contract is gated on.
 *
 * The submission endpoint is a placeholder — see writeShareDocument's doc.
 * No network call happens anywhere in this file.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TOOL_VERSION } from "./version.js";
import type { ModelBenchResult, HostFingerprint, ShareDocument } from "./types.js";

/** Config placeholder for the future hosted submission endpoint (not implemented — see README "Stubbed"). */
export const SUBMISSION_ENDPOINT_PLACEHOLDER = "https://bench.tps.dev/api/submit"; // not live; no network call is ever made against this

function deriveModelName(fileBasename: string): string {
  // Strip a trailing .gguf and a recognizable quant/variant suffix so the
  // "name" reads as the model family, e.g. "nomic-embed-text-v1.5.Q4_K_M.gguf"
  // -> "nomic-embed-text-v1.5". Best-effort — falls back to the basename
  // minus extension if no quant suffix is recognized.
  const withoutExt = fileBasename.replace(/\.gguf$/i, "");
  const withoutQuant = withoutExt.replace(/\.((?:Q|IQ)[0-9][A-Z0-9_]*|F16|F32|BF16)$/i, "");
  return withoutQuant;
}

export function buildShareDocument(result: ModelBenchResult, host: HostFingerprint): ShareDocument {
  return {
    toolVersion: TOOL_VERSION,
    timestamp: new Date().toISOString(),
    model: {
      name: deriveModelName(result.model.fileName),
      fileBasename: result.model.fileName,
      sha256: result.model.sha256,
      quant: result.model.quant,
      paramsApprox: result.model.paramsApprox,
      dims: result.model.dims,
    },
    hardware: {
      label: host.label,
      platform: host.platform,
      arch: host.arch,
      cpuModel: host.cpuModel,
      ramGiB: Math.round(host.totalRamGiB * 10) / 10,
      gpu: host.gpuDeviceNames.length > 0 ? host.gpuDeviceNames.join(", ") : null,
      backend: host.backend,
    },
    results: {
      aggregate: result.aggregate,
      perKind: result.perKind,
      msPerEmbedSerialWarm: Math.round(result.msPerEmbedSerialWarm * 100) / 100,
      peakRssMiB: Math.round(result.peakRssDeltaMiB * 10) / 10,
    },
  };
}

export interface WrittenShare {
  filePath: string;
  endpointNote: string;
}

/**
 * Writes the share document locally and returns where. The hosted
 * submission endpoint (SUBMISSION_ENDPOINT_PLACEHOLDER) is not wired up —
 * this function never makes a network call; the CLI layer is what prints
 * `endpointNote` to the user (core does no console output — see index.ts's
 * header).
 */
export function writeShareDocument(doc: ShareDocument, outDir: string = "."): WrittenShare {
  mkdirSync(outDir, { recursive: true });
  const safeModelName = doc.model.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `flair-bench-share-${safeModelName}-${doc.timestamp.replace(/[:.]/g, "-")}.json`;
  const filePath = join(outDir, fileName);
  writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return {
    filePath,
    endpointNote: `submission endpoint not yet configured — file saved at ${filePath}`,
  };
}
