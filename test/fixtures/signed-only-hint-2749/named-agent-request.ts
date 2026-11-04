// Child process for test/integration/signed-only-hint-2749.test.ts: one
// signed-only `authedRequest` naming agent-2749, under the HOME and
// FLAIR_KEY_DIR the parent passes in its environment. Prints the outcome as one
// JSON line on stdout.
//
// Usage: bun named-agent-request.ts <base url> <keys dir> <route>
import { ApiHttpError, authedRequest } from "../../../src/lib/auth-resolve.ts";

async function main(): Promise<void> {
  const [baseUrl, keysDir, route] = process.argv.slice(2);
  if (!baseUrl || !keysDir || !route) throw new Error("usage: named-agent-request.ts <base url> <keys dir> <route>");
  try {
    await authedRequest("GET", route, undefined, { baseUrl, keysDir, agentId: "agent-2749", agentIdSource: "env", signedOnly: true });
    console.log(JSON.stringify({ resolved: true }));
  } catch (err: unknown) {
    console.log(
      JSON.stringify(
        err instanceof ApiHttpError
          ? { status: err.status, noCredentials: err.noCredentials, message: err.message }
          : { error: err instanceof Error ? err.message : String(err) },
      ),
    );
  }
}

await main();
