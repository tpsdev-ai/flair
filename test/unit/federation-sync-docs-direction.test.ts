import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * flair#934 — docs/federation.md must describe the FederationSync direction
 * that actually exists: POST-only push. Sibling resources in the same file
 * declare get(), so a missing get() on FederationSync is not the framework
 * supplying a read side. The SyncLog row written with direction: "pull" is
 * the hub logging that it received a push, not a spoke fetching.
 *
 * This assertion is the known-answer case: it fails on origin/main (the
 * Overview still says spokes receive hub/peer changes and the hub relays)
 * and passes once the page matches the resource.
 */

const ROOT = join(import.meta.dir, "../..");
const FEDERATION_TS = join(ROOT, "resources", "Federation.ts");
const FEDERATION_MD = join(ROOT, "docs", "federation.md");

const HTTP_VERBS = ["get", "post", "put", "patch", "delete"] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function classSource(src: string, className: string, nextClass: string): string {
  const start = src.indexOf(`export class ${className}`);
  const end = src.indexOf(`export class ${nextClass}`);
  expect(start, `missing export class ${className}`).toBeGreaterThan(-1);
  expect(end, `missing export class ${nextClass} after ${className}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function declaredHttpVerbs(classSrc: string): string[] {
  const body = stripComments(classSrc);
  return HTTP_VERBS.filter((verb) => new RegExp(`\\basync\\s+${verb}\\s*\\(`).test(body));
}

function overviewSection(doc: string): string {
  const after = doc.split("## Overview\n")[1];
  expect(after, "docs/federation.md is missing ## Overview").toBeDefined();
  return after.split("\n## ")[0] ?? "";
}

describe("FederationSync direction (flair#934)", () => {
  const federationTs = readFileSync(FEDERATION_TS, "utf8");
  const federationMd = readFileSync(FEDERATION_MD, "utf8");
  const syncClass = classSource(federationTs, "FederationSync", "FederationPeers");
  const instanceClass = classSource(federationTs, "FederationInstance", "FederationPair");
  const peersClass = federationTs.slice(federationTs.indexOf("export class FederationPeers"));
  const overview = overviewSection(federationMd);

  it("FederationSync declares post() and no other HTTP verb", () => {
    expect(declaredHttpVerbs(syncClass)).toEqual(["post"]);
  });

  it("sibling Federation resources declare get() — a missing get() is not implicit", () => {
    expect(declaredHttpVerbs(instanceClass)).toContain("get");
    expect(declaredHttpVerbs(peersClass)).toContain("get");
  });

  it("docs/federation.md Overview does not claim spokes receive hub changes or that the hub relays", () => {
    expect(overview).not.toMatch(/receives changes from other spokes via the hub/i);
    expect(overview).not.toMatch(/can relay records between peers/i);
  });

  it("docs/federation.md Overview matches FederationSync's push-only direction", () => {
    expect(overview).toMatch(/push-only/i);
    expect(overview).toMatch(/receives nothing back/i);
    expect(overview).toMatch(/no pull/i);
    expect(overview).toContain("POST /FederationSync");
    expect(overview).not.toMatch(/Hub\s+[─\-].*Spoke/i);
  });
});
