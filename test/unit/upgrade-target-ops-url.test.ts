/**
 * upgrade-target-ops-url.test.ts — `flair upgrade --target` resolves the
 * target's operations API URL the way every remote command does
 * (--ops-target, else FLAIR_OPS_TARGET, else derived from --target) and hands
 * it to fabricUpgrade(), which passes it to deploy() for the MQTT-off
 * configuration, restart and read-back (test/unit/fabric-upgrade.test.ts and
 * test/integration/mqtt-off-fabric-upgrade.test.ts check that hop).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildFabricUpgradeOptions } from "../../src/commands/upgrade.ts";
import { resolveEffectiveOpsUrl } from "../../src/cli.ts";

const priorEnv = process.env.FLAIR_OPS_TARGET;
afterEach(() => {
  if (priorEnv === undefined) delete process.env.FLAIR_OPS_TARGET;
  else process.env.FLAIR_OPS_TARGET = priorEnv;
});

const creds = { fabricUser: "admin", fabricPassword: "not-a-secret" };

describe("flair upgrade --target: the operations API URL handed to fabricUpgrade()", () => {
  test("--ops-target wins", () => {
    process.env.FLAIR_OPS_TARGET = "https://env-ops.example.invalid:9925";
    const o = buildFabricUpgradeOptions({ target: "https://prod.acme.example.invalid", opsTarget: "https://flag-ops.example.invalid:9925/" }, creds, resolveEffectiveOpsUrl);
    expect(o.opsUrl).toBe("https://flag-ops.example.invalid:9925");
  });

  test("FLAIR_OPS_TARGET without the flag", () => {
    process.env.FLAIR_OPS_TARGET = "https://env-ops.example.invalid:9925";
    const o = buildFabricUpgradeOptions({ target: "https://prod.acme.example.invalid" }, creds, resolveEffectiveOpsUrl);
    expect(o.opsUrl).toBe("https://env-ops.example.invalid:9925");
  });

  test("neither: derived from --target as for every remote command", () => {
    delete process.env.FLAIR_OPS_TARGET;
    expect(buildFabricUpgradeOptions({ target: "https://prod.acme.example.invalid" }, creds, resolveEffectiveOpsUrl).opsUrl)
      .toBe("https://prod.acme.example.invalid:9925");
    expect(buildFabricUpgradeOptions({ target: "http://127.0.0.1:19926" }, creds, resolveEffectiveOpsUrl).opsUrl)
      .toBe("http://127.0.0.1:19925");
  });

  test("--no-verify is carried to fabricUpgrade() as verify: false; without it, verify: true", () => {
    delete process.env.FLAIR_OPS_TARGET;
    expect(buildFabricUpgradeOptions({ target: "https://t.example.invalid", verify: false }, creds, resolveEffectiveOpsUrl).verify).toBe(false);
    expect(buildFabricUpgradeOptions({ target: "https://t.example.invalid", verify: true }, creds, resolveEffectiveOpsUrl).verify).toBe(true);
    expect(buildFabricUpgradeOptions({ target: "https://t.example.invalid" }, creds, resolveEffectiveOpsUrl).verify).toBe(true);
  });

  test("the other options are carried as the command sets them", () => {
    delete process.env.FLAIR_OPS_TARGET;
    const o = buildFabricUpgradeOptions({ target: "https://t.example.invalid", keepMqttConfig: true, restart: false, replicated: false, check: true }, creds, resolveEffectiveOpsUrl);
    expect(o).toMatchObject({ target: "https://t.example.invalid", keepMqttConfig: true, restart: false, replicated: false, check: true, fabricUser: "admin" });
  });
});
