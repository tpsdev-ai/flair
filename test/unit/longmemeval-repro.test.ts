import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyArtifactHash } from "../bench/longmemeval/artifact";
import { hashConfig, canonicalJson } from "../bench/longmemeval/config";

/**
 * HISTORICAL-VARIANT reproducibility for the LongMemEval bench (flair#1366).
 *
 * The harness that produced our headline numbers lived only on the tps-bench
 * VM, so "run it yourself" reproduced a DIFFERENT harness than the one that made
 * the numbers. #1366 ported it. This test is the standing proof that the gap
 * stays closed as the harness keeps moving.
 *
 * ── What this test asserts, and why it is shaped this way ──────────────────
 *
 * The naive version pins "the manifest that current code emits" to a literal
 * hash. That version is wrong, and #1364 proved it within a day: adding
 * `prompts.readerPayloadFormat` — a legitimate measurement change — broke the
 * pin, and the only ways to get green again would have been to re-pin to a new
 * number (destroying the property being protected) or delete the test.
 *
 * So the assertion is instead: **repo code can still reconstruct the manifest
 * of a PAST run and reproduce its recorded configHash.** For each committed
 * historical artifact, the current manifest is projected onto exactly the key
 * set that artifact recorded, and the projection must hash to the artifact's
 * `configHash`.
 *
 * That gives the right failure behavior in every direction:
 *
 *   - a field is ADDED to the manifest (a new measurement variant) -> the
 *     projection drops it, the historical hash still reproduces, no churn.
 *     The new field still governs the identity of NEW runs through the ordinary
 *     configHash path; it is simply not part of what the old run was.
 *   - a pinned VALUE the old run depended on changes (a model digest, a prompt
 *     string, the extraction method, a dataset pin) -> the projection differs
 *     and this FAILS. That is the real regression: the repo can no longer
 *     express the configuration that produced a published number.
 *   - a field the old run HAD is removed -> the projection is missing a key and
 *     this FAILS, which is correct for the same reason.
 *
 * WHEN THIS FAILS, do not re-pin the expected hash and do not relax the
 * projection. A failure means a published number is no longer reproducible from
 * repo code. Either the change was unintended (revert it), or it is deliberate
 * — in which case the affected headline must be RE-RUN and its artifact
 * replaced, which is a decision with a cost, not a test edit.
 *
 * Adding a new headline later? Commit its artifact and add a row to
 * HISTORICAL_VARIANTS. Old rows stay; that is the point.
 *
 * ── Scope: what this does NOT prove ───────────────────────────────────────
 *
 * It reproduces the CONFIG identity, not the numbers. Under the `cloud` profile
 * the reader is not deterministic at temperature 0 / seed 0 (measured: four
 * calls, byte-identical prompt, three distinct completions — batched cloud
 * inference is not bitwise-stable), so `runHash` and `artifactHash` cannot be
 * re-derived by anyone. Note also that `artifactHash` covers latency
 * percentiles and so is not wall-clock invariant. `configHash` is the
 * reproducible identity; see the README section "What 'reproducible' does and
 * does not mean here".
 */

const RESULTS_DIR = join(import.meta.dir, "..", "bench", "longmemeval", "results");
const CONFIG_TS = join(import.meta.dir, "..", "bench", "longmemeval", "config.ts");

interface HistoricalVariant {
  /** What ran, in one line — this is what a reviewer reads first. */
  label: string;
  artifactFile: string;
  configHash: string;
  artifactHash: string;
  profile: "local" | "cloud";
  /** Overrides run.ts applies to the manifest after configManifest(). */
  armsFrom: "artifact";
  ingestionSharingFrom: "artifact";
}

const HISTORICAL_VARIANTS: HistoricalVariant[] = [
  {
    label:
      "published headline — tps-bench 2026-08-23, n=500 (all of LongMemEval_s), seed 0, " +
      "1 run, arms flair+vector-only+no-context, shared-store ingest-reuse, cloud pins, " +
      "v1 reader payload (pre-#1364)",
    artifactFile: "longmemeval-s-artifact-635df13be42d3f30.json",
    configHash: "a43d28c920a436b6a2f96ce60b178de5bf17e3e29c59f250b8d7a68098d06a51",
    artifactHash: "635df13be42d3f30e9db7a9e3cd2d032aa0f9e426d19d938052976032c935b98",
    profile: "cloud",
    armsFrom: "artifact",
    ingestionSharingFrom: "artifact",
  },
];

/** The pinned LOCAL models, as they stood before #1366 introduced profiles.
 *  These are VALUES, not a manifest shape, so they are immune to the
 *  manifest-shape churn that makes a whole-manifest hash pin a treadmill. */
const LOCAL_PINS = {
  judge: {
    model: "gemma4:31b-it-q8_0",
    manifestDigest: "sha256:53dd8459790f8795177444daa9e33f417e03c0d1cdedb80b6c73898603d20aef",
    weightsSha256: "sha256:a0feadb736f521df6de4b1bd3cbf06c00f9fd04570ddc1e47b8ec9ecbbd6b51d",
    family: "gemma4",
    temperature: 0,
    seed: 0,
    numCtx: 8192,
    numPredict: 16,
  },
  reader: {
    model: "qwen3.6:27b-coding-mxfp8",
    manifestDigest: "sha256:a7185d39ff35a472a2721b87e1bbb90810bcd381d415666ce2137838e66f2780",
    family: "qwen3_5",
    temperature: 0,
    seed: 0,
    numCtx: 16384,
    numPredict: 256,
  },
};

const loadArtifact = (file: string) => JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8"));

/**
 * Keep only the keys `template` has, recursively — the "as this variant
 * recorded it" projection. Arrays are taken whole: they are ordered values
 * (questionIds, arms), not key sets to be filtered.
 */
function projectOnto(template: unknown, value: unknown): unknown {
  if (Array.isArray(template)) return value;
  if (template && typeof template === "object" && value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(template as Record<string, unknown>)) {
      if (k in (value as Record<string, unknown>)) {
        out[k] = projectOnto(
          (template as Record<string, unknown>)[k],
          (value as Record<string, unknown>)[k],
        );
      }
    }
    return out;
  }
  return value;
}

/**
 * The model profile is process-wide and read at import time, so each profile
 * must be measured in its own process — importing config.ts twice with
 * different environments is not possible in one. A subprocess that failed
 * would otherwise yield an empty string that compares unequal for the wrong
 * reason, so a non-zero exit or any stderr is raised loudly instead.
 */
async function inProfile(env: Record<string, string | undefined>, body: string): Promise<string> {
  const script = `import { configManifest, hashConfig, JUDGE, READER, MODEL_PROFILE } from ${JSON.stringify(CONFIG_TS)};\n${body}`;
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(script),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || err.trim()) {
    throw new Error(`profile subprocess failed (exit ${code}): ${err.slice(0, 500)}`);
  }
  return out.trim();
}

/** The manifest current repo code emits for a historical variant's run params. */
async function currentManifestFor(v: HistoricalVariant, config: Record<string, any>): Promise<any> {
  const json = await inProfile(
    { LME_MODEL_PROFILE: v.profile, LME_FULL_CTX: String(config.fullContext.numCtx) },
    `
      const c = ${JSON.stringify(config)};
      const m = configManifest({
        n: c.slice.n, seed: c.slice.seed, runs: c.slice.runs, questionIds: c.slice.questionIds,
      });
      // The two artifact-affecting overrides run.ts applies — see run.ts.
      m.arms = c.arms;
      m.ingestion = { ...m.ingestion, harperStoreSharing: c.ingestion.harperStoreSharing };
      process.stdout.write(JSON.stringify(m));
    `,
  );
  return JSON.parse(json);
}

describe("longmemeval historical-variant reproducibility (#1366)", () => {
  for (const v of HISTORICAL_VARIANTS) {
    describe(v.label, () => {
      const artifact = loadArtifact(v.artifactFile);

      test("the committed artifact self-verifies", () => {
        expect(artifact.configHash).toBe(v.configHash);
        expect(artifact.artifactHash).toBe(v.artifactHash);
        expect(verifyArtifactHash(artifact)).toBe(true);
      });

      test("a tampered artifact does NOT self-verify", () => {
        // Positive control: without it, verifyArtifactHash returning true above
        // would be consistent with it returning true for anything.
        const tampered = JSON.parse(JSON.stringify(artifact));
        tampered.config.slice.n = artifact.config.slice.n - 1;
        expect(verifyArtifactHash(tampered)).toBe(false);
      });

      test("repo code reconstructs this variant's manifest and reproduces its configHash", async () => {
        const current = await currentManifestFor(v, artifact.config);
        const reconstructed = projectOnto(artifact.config, current);
        // Hash equality implies byte-identical canonical JSON, i.e. exactly the
        // same keys AND values — so the projection cannot pass vacuously.
        expect(hashConfig(reconstructed)).toBe(v.configHash);
      });

      test("every field this variant recorded is still expressible from repo code", async () => {
        // Same property as above, asserted field-by-field so a failure names the
        // field that drifted instead of only reporting two unequal hashes.
        const current = await currentManifestFor(v, artifact.config);
        for (const key of Object.keys(artifact.config)) {
          expect({ [key]: projectOnto(artifact.config[key], current[key]) })
            .toEqual({ [key]: artifact.config[key] });
        }
      });

      test("the harness HAS evolved since this variant — the projection is doing real work", async () => {
        // Guards the opposite failure: if the projection were a no-op, this test
        // file would silently degrade into "nothing ever changes" and stop
        // proving that old artifacts survive harness evolution.
        const current = await currentManifestFor(v, artifact.config);
        const addedSinceVariant = Object.keys(current.prompts)
          .filter((k) => !(k in artifact.config.prompts));
        // As of #1364 this is ["readerPayloadFormat"]. Not pinned to that exact
        // list on purpose — pinning it would be the treadmill this test exists
        // to avoid. Only the DIRECTION is asserted: current is a superset.
        expect(Object.keys(current.prompts).length)
          .toBeGreaterThanOrEqual(Object.keys(artifact.config.prompts).length);
        if (addedSinceVariant.length > 0) {
          expect(hashConfig(current)).not.toBe(v.configHash);
        }
      });
    });
  }

  describe("model profiles", () => {
    test("the local pins are exactly what they were before profiles were introduced", async () => {
      // The neutrality property of #1366: cloud pins were added as a PROFILE
      // rather than by editing the constants in place (which is what tps-bench
      // did), so no already-published local run is invalidated. Asserted on the
      // PIN VALUES rather than a whole-manifest hash, so legitimate manifest
      // growth does not force this to be rewritten.
      const got = JSON.parse(await inProfile({ LME_MODEL_PROFILE: undefined },
        `process.stdout.write(JSON.stringify({ profile: MODEL_PROFILE, judge: JUDGE, reader: READER }));`));
      expect(got.profile).toBe("local");
      expect(got.judge).toEqual(LOCAL_PINS.judge);
      expect(got.reader).toEqual(LOCAL_PINS.reader);
    });

    test("the cloud pins are exactly what the published headline recorded", async () => {
      // Ties the cloud profile to the published record rather than to a second
      // copy of the same literals: if these ever diverge, the headline stops
      // being reproducible, and that is the thing worth failing on.
      const headline = loadArtifact(HISTORICAL_VARIANTS[0]!.artifactFile);
      const got = JSON.parse(await inProfile({ LME_MODEL_PROFILE: "cloud" },
        `process.stdout.write(JSON.stringify({ judge: JUDGE, reader: READER }));`));
      expect(got.judge).toEqual(headline.config.judge);
      expect(got.reader).toEqual(headline.config.reader);
    });

    test("absent, empty and explicit 'local' are the same configuration", async () => {
      // A CI runner that materialises an undefined variable as "" must not take
      // a different path from one that omits it.
      const pins = `process.stdout.write(JSON.stringify({ p: MODEL_PROFILE, j: JUDGE.model, r: READER.model }));`;
      const absent = await inProfile({ LME_MODEL_PROFILE: undefined }, pins);
      const empty = await inProfile({ LME_MODEL_PROFILE: "" }, pins);
      const explicit = await inProfile({ LME_MODEL_PROFILE: "local" }, pins);
      expect(empty).toBe(absent);
      expect(explicit).toBe(absent);
    });

    test("the profile switch is not inert", async () => {
      // If the selector silently resolved to one profile, a cloud run and a
      // local run would be indistinguishable by configHash — exactly the
      // collision the hash exists to prevent.
      const ref = `
        const m = configManifest({ n: 2, seed: 0, runs: 1, questionIds: ["q-a", "q-b"] });
        process.stdout.write(hashConfig(m));
      `;
      const local = await inProfile({ LME_MODEL_PROFILE: "local" }, ref);
      const cloud = await inProfile({ LME_MODEL_PROFILE: "cloud" }, ref);
      expect(cloud).not.toBe(local);
    });

    test("an unknown profile is fatal, not a silent fallback", async () => {
      // A free-form string compared by exact match must fail CLOSED: an
      // unrecognised profile has to stop the run, never quietly select a
      // default and mislabel the artifact's pins.
      await expect(
        inProfile({ LME_MODEL_PROFILE: "cloudy" }, `process.stdout.write(MODEL_PROFILE);`),
      ).rejects.toThrow();
    });
  });

  test("canonicalJson is order-independent, which is what makes the hash portable", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(hashConfig({ x: 1, y: 2 })).toBe(hashConfig({ y: 2, x: 1 }));
  });
});
