// basic-auth-lookup-fail-2403 — TEST-ONLY resource for flair#2403's real-Harper
// integration test (test/integration/basic-auth-lookup-fail-closed-2403.test.ts).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-basic-auth-lookup-fail-2403.js, so the component's own
// `jsResource` glob loads it next to the real resources. Nothing under resources/
// references it and it is never packed or shipped.
//
// It makes the Agent-table read FAIL for exactly one principal id, so a
// credentialed Basic request for that principal reaches the auth code with a
// lookup that rejects — the failed-read case flair#2403 refuses. Every other id
// reads normally, so seeding and the rest of the instance are untouched.
import { Resource, databases } from "harper";

const FAIL_ID = "basic-lookup-fail-2403";

function installAgentLookupFailure() {
  const Agent = databases?.flair?.Agent;
  if (!Agent || typeof Agent.get !== "function") return false;
  if (Agent.__flair2403FailureInstalled) return true;
  const original = Agent.get.bind(Agent);
  const failGet = (id, ...rest) =>
    id === FAIL_ID
      ? Promise.reject(new Error("injected Agent lookup failure (flair#2403 test-only)"))
      : original(id, ...rest);
  try {
    Agent.get = failGet;
  } catch {
    return false;
  }
  if (Agent.get !== failGet) return false;
  Agent.__flair2403FailureInstalled = true;
  return true;
}

// Best-effort at load; the test also POSTs to the probe to arm it once the
// Agent table is registered.
installAgentLookupFailure();

export class BasicAuthLookupFail2403 extends Resource {
  async post() {
    return { installed: installAgentLookupFailure() };
  }
}
