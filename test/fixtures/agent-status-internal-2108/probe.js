// agent-status-internal-2108 — TEST-ONLY resource for flair#2108's integration
// test (test/integration/agent-status-admin-only.test.ts).
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-agent-status-internal-2108.js, so the component's own
// `jsResource` glob loads it next to the real resources. Nothing under
// resources/ references it and it is never packed or shipped.
//
// POST { id, data } calls the REAL Agent resource's PATCH in-process, with the
// trusted internal context (resources/in-process.ts's internalContext()), and
// answers with what the resource returned. No allow* override: Harper's default
// admits only a super_user, so only the test's admin Basic credential reaches it.
import { Resource, server } from "harper";
import { internalContext } from "./in-process.js";

export class AgentStatusInternalProbe2108 extends Resource {
  async post({ id, data }) {
    const entry = server.resources.get("Agent");
    if (!entry) throw new Error("the Agent resource is not registered");
    const result = await entry.Resource.patch(id, data, internalContext());
    if (result instanceof Response) return { refused: result.status, body: await result.text() };
    return { refused: null };
  }
}
