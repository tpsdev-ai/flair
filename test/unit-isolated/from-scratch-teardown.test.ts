import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const shell = readFileSync(resolve(root, "docker/test-from-scratch.sh"), "utf8");
const teardown = shell.split("<<'NODE'\n")[1]?.split("\nNODE")[0];
if (!teardown) throw new Error("Missing from-scratch teardown program");
const probe = resolve(root, "src/lib/init-tcp-probe.ts");
const program = teardown.replace("import { localPortState } from '/app/dist/lib/init-tcp-probe.js';",
  `const { localPortState } = await import(${JSON.stringify(probe)});`);

type Scenario = "delayed" | "live-pid" | "occupied" | "unknown" | "probe-error" | "permission" | "bad-pid";

function run(scenario: Scenario) {
  const code = `
    import { mock } from "bun:test";
    const scenario = ${JSON.stringify(scenario)};
    let time = 0;
    let signals = 0;
    let checks = 0;
    Date.now = () => time;
    process.argv = ["node", "-", "/fixture/data", "9926"];
    process.kill = (pid, signal) => {
      if (pid !== 4242) throw new Error("Wrong PID signalled");
      if (scenario === "permission") throw Object.assign(new Error("denied"), { code: "EPERM" });
      if (signal === "SIGTERM") { signals++; return true; }
      if (signal !== 0) throw new Error("Unexpected signal");
      checks++;
      if (scenario === "live-pid" || (scenario === "delayed" && time < 1000)) return true;
      throw Object.assign(new Error("exited"), { code: "ESRCH" });
    };
    mock.module("node:fs", () => ({ readFileSync: (path) => {
      if (path !== "/fixture/data/hdb.pid") throw new Error("Wrong pidfile");
      return scenario === "bad-pid" ? "invalid" : "4242\\n";
    } }));
    mock.module("node:timers/promises", () => ({ setTimeout: async ms => { time += ms; } }));
    mock.module(${JSON.stringify(probe)}, () => ({ localPortState: async (port, host) => {
      if (port !== 9926 || host !== "127.0.0.1") throw new Error("Wrong TCP probe");
      if (signals !== 1 || checks === 0) throw new Error("Probed before stopping/checking PID");
      if (scenario === "probe-error") throw new Error("probe unavailable");
      if (scenario === "unknown") return "unknown";
      if (scenario === "occupied" || (scenario === "delayed" && time < 2000)) return "listening";
      if (scenario === "delayed" && time < 1000) throw new Error("Early success");
      return "free";
    } }));
    ${program}
  `;
  return spawnSync("bun", ["--eval", code], { cwd: root, encoding: "utf8", timeout: 5000 });
}

test("teardown waits for both the recorded PID and TCP refusal without lsof", () => {
  const result = run("delayed");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Harper PID 4242 exited; port 9926 refuses TCP connections");
}, 10_000);

for (const scenario of ["live-pid", "occupied", "unknown"] as const) {
  test(`teardown fails loudly on ${scenario} timeout`, () => {
    const result = run(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harper teardown timed out");
    expect(result.stderr).toContain(scenario === "live-pid" ? "still running" : `port 9926 is ${scenario === "occupied" ? "listening" : "unknown"}`);
    expect(result.stdout).not.toContain("refuses TCP");
  }, 10_000);
}

for (const scenario of ["probe-error", "permission", "bad-pid"] as const) {
  test(`teardown refuses when ${scenario} prevents proof`, () => {
    const result = run(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(scenario === "probe-error" ? "probe unavailable" : scenario === "permission" ? "denied" : "Invalid Harper PID");
    expect(result.stdout).not.toContain("refuses TCP");
  }, 10_000);
}
