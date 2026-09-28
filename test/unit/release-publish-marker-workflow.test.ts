/**
 * release-publish-marker-workflow.test.ts — flair#1928 slice 1.
 *
 * The `release-attempt` deployment marker must carry the CERTIFIED values
 * stage-publish already re-derived from the artifact it staged — the package-set
 * digest and the manifest sha256, plus the version — so the promote job can read
 * them as DATA (never by running a tag's code, never from main's package.json).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const RAW = readFileSync(join(REPO, ".github", "workflows", "release-publish.yml"), "utf8");

describe("release-publish marker — the certified digest travels with the release attempt", () => {
  test("the marker POST body carries a payload with package_set_digest, manifest_sha256 and version", () => {
    const m = RAW.match(/MARKER_BODY="\$\(jq -n[^\n]*/);
    expect(m, "the marker body is built with jq").not.toBeNull();
    const body = m![0];
    expect(body).toContain("payload:");
    expect(body).toContain("package_set_digest:");
    expect(body).toContain("manifest_sha256:");
    expect(body).toContain("version:");
  });

  test("the payload values come from stage-publish's OWN re-derivation, not a job output", () => {
    const m = RAW.match(/MARKER_BODY="\$\(jq -n[^\n]*/);
    const body = m![0];
    // $PACKAGE_SET_DIGEST and $MANIFEST_DIGEST are computed in THIS job (the
    // pre-stage re-hash), not read from pack's job outputs.
    expect(body).toContain("$PACKAGE_SET_DIGEST");
    expect(body).toContain("$MANIFEST_DIGEST");
    expect(body).toContain("$VERSION_TOP");
  });

  test("a payload digest that disagrees with the manifest's digest refuses BEFORE any stage request", () => {
    // The pre-stage assertions that bind PACKAGE_SET_DIGEST to the manifest field
    // and to pack's output, and abort if either differs.
    expect(RAW).toContain("PACKAGE_SET_DIGEST\" != \"$MANIFEST_SET_DIGEST\"");
    expect(RAW).toMatch(/package-set digest \$PACKAGE_SET_DIGEST differs from the manifest field/);
    // …and the marker is written BEFORE anything is staged.
    const markerIdx = RAW.indexOf("could not write the release-attempt marker");
    const stageIdx = RAW.indexOf("Stage each tarball");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(stageIdx);
  });
});
