import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const wf = yaml.load(readFileSync(join(import.meta.dir, "../../.github/workflows/release-promote-poll.yml"), "utf8")) as {
  jobs: { poll: { steps: { name?: string; run?: string }[] } };
};
const script = wf.jobs.poll.steps.find((step) => step.name === "Poll and dispatch")!.run!;
const gate = script.slice(script.indexOf('REF_ERROR="$(mktemp)"'), script.indexOf("# Match only the tag non-dry-run title"));

for (const status of [200, 404, 503]) {
  test(`the tag contents gate handles HTTP ${status} through the real gh CLI`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-real-gh-"));
    const requests: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname + new URL(request.url).search);
          return Response.json(status === 200 ? { type: "file" } : { message: status === 404 ? "Not Found" : "Unavailable (HTTP 404)" }, { status });
        },
      });
      const file = join(dir, "gate.sh");
      writeFileSync(file, `set -euo pipefail
function gh() { shift; command gh api "\${TEST_API_URL}/$1"; }
HANDLED="${join(dir, "handled")}"
REPO=octo/repo
for version in 1.2.3; do
  ref="v\${version}"
  ${gate}
  echo dispatchable
done
`);
      const child = Bun.spawn(["bash", file], {
        env: { ...process.env, GH_TOKEN: "fixture", GH_HOST: "github.com", TEST_API_URL: server.url.toString().replace(/\/$/, "") },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(requests).toEqual(["/repos/octo/repo/contents/.github/workflows/release-promote.yml?ref=v1.2.3"]);
      expect(code, stderr).toBe(status === 503 ? 1 : 0);
      expect(stdout.includes("dispatchable")).toBe(status === 200);
      expect(stdout.includes("the release-promote workflow is not available at this tag ref; not dispatching")).toBe(status === 404);
      if (status === 503) expect(stderr).toContain("refusing to dispatch");
    } finally {
      server?.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
