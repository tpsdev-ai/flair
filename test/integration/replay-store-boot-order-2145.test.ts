/** The XAA replay-store warning is written before Harper serves a request. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent } from "../helpers/component-with-replay-probe";

let component: ProbeComponent | undefined;
let harper: HarperInstance | undefined;

describe("XAA replay-store boot report ordering (flair#2145)", () => {
  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("boot-order test requires a local Harper spawn");
    component = componentWithReplayProbe({
      probe: {
        source: join("test", "fixtures", "oauth-single-use-probe-2145", "boot-order.js"),
        target: join("dist", "resources", "zz-replay-boot-order-2145.js"),
        out: "unused-replay-boot-order-2145",
      },
    });
    const schemaPath = join(component.dir, "schemas", "oauth.graphql");
    const schema = readFileSync(schemaPath, "utf8");
    const original = 'type IdJagReplay @table(database: "flair", expiration: 90000)';
    expect(schema.includes(original)).toBe(true);
    writeFileSync(schemaPath, schema.replace(original, 'type IdJagReplay @table(database: "flair", expiration: 3600)'));
    harper = await startHarper({ cwd: component.dir, harperBinDir: component.sourceRoot, threads: 1 });
    expect(harper.external).toBe(false);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    component?.cleanup();
  });

  test("the warning precedes a served resource request", async () => {
    const warning = "ReplayStoreUnavailable at boot (XAA jti: flair.IdJagReplay keeps rows 3600000 ms";
    const beforeRequest = harper!.getLog?.() ?? "";
    expect(beforeRequest).toContain(warning);

    const response = await fetch(`${harper!.httpURL}/ReplayBootOrderProbe`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ served: true });

    const marker = "[replay-boot-order-probe] request served";
    const deadline = Date.now() + 5_000;
    while (!(harper!.getLog?.() ?? "").includes(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const log = harper!.getLog?.() ?? "";
    expect(log.indexOf(warning)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(marker)).toBeGreaterThan(log.indexOf(warning));
  });
});
