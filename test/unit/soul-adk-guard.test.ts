import { describe, expect, test } from "bun:test";
import {
  ADK_SOUL_REFUSAL,
  bodyCarriesAdkScope,
  refuseAdkSourcedSoulWrite,
  rowLooksAdkSourced,
} from "../../resources/soul-adk-guard";

const empty: AsyncIterable<any> = { async *[Symbol.asyncIterator]() { /* none */ } };

describe("ADK→Soul refusal", () => {
  test("a body with an adk scope tag or tag list is ADK-sourced", () => {
    expect(bodyCarriesAdkScope({ scopeTag: "adk:app:user" })).toBe(true);
    expect(bodyCarriesAdkScope({ tags: ["nightly-rem-promoted", "adk:app:user"] })).toBe(true);
    expect(bodyCarriesAdkScope({ scopeTag: "ADK:app:user" })).toBe(true);
    expect(bodyCarriesAdkScope({ tags: ["Adk:app:user"] })).toBe(true);
    expect(bodyCarriesAdkScope({ tags: ["nightly-rem-promoted"], value: "plain" })).toBe(false);
  });

  test("stored rows are ADK-sourced only with an adk: tag", () => {
    expect(rowLooksAdkSourced({ scopeTag: "adk:continuity:s1" })).toBe(true);
    expect(rowLooksAdkSourced({ tags: ["adk:app:user"] })).toBe(true);
    expect(rowLooksAdkSourced({ tags: ["nightly-rem-promoted"] })).toBe(false);
  });

  test("scripted PUT /Soul with an ADK candidate claim is 403", async () => {
    const denied = await refuseAdkSourcedSoulWrite(
      { agentId: "shared-app", value: "this user prefers dark mode" },
      {
        searchCandidates: async function* () {
          yield { claim: "this user prefers dark mode", scopeTag: "adk:app:alice" };
        },
        searchMemories: async function* () {},
      },
    );
    expect(denied?.status).toBe(403);
    expect(await denied!.json()).toEqual({ error: ADK_SOUL_REFUSAL });
  });

  test("scripted PUT /Soul matching an ADK-tagged memory is 403", async () => {
    const denied = await refuseAdkSourcedSoulWrite(
      { agentId: "shared-app", value: "remember my nickname" },
      {
        searchCandidates: async function* () {},
        searchMemories: async function* () {
          yield { content: "remember my nickname", tags: ["adk:app:bob"] };
        },
      },
    );
    expect(denied?.status).toBe(403);
  });

  test("an ordinary Soul value that is not ADK-sourced is allowed", async () => {
    const allowed = await refuseAdkSourcedSoulWrite(
      { agentId: "writer", value: "Be concise. Prefer evidence over vibe." },
      { searchCandidates: async function* () {}, searchMemories: async function* () {} },
    );
    expect(allowed).toBeNull();
  });

  test("empty lookup sources do not refuse a non-tagged body", async () => {
    const allowed = await refuseAdkSourcedSoulWrite(
      { agentId: "writer", value: "role: cofounder" },
      { searchCandidates: () => empty, searchMemories: () => empty },
    );
    expect(allowed).toBeNull();
  });
});
