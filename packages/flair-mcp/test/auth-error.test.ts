import { describe, expect, test } from "bun:test";
import { FlairError, formatKeyLookup } from "@tpsdev-ai/flair-client";
import { classifyError } from "../src/index.ts";

/**
 * flair#1271 — a 401 must name the agent, the paths that were looked in,
 * and the remedy. The daemon-restart hint is the WRONG first guess when
 * auto-resolve missed a key that is sitting on disk.
 */
describe("classifyError 401 names key lookup (flair#1271)", () => {
  test("unsigned 401 includes actor, looked-in paths, and FLAIR_KEY_PATH remedy", () => {
    const lookup = {
      agentId: "grok-cos",
      home: "/home/agent",
      candidates: [
        { path: "/home/agent/.flair/keys/grok-cos.key", exists: false },
      ],
      resolvedPath: null,
      signed: false,
    };
    const err = new FlairError("POST", "/BootstrapMemories", 401, "unauthorized", lookup);
    const text = classifyError(err, "https://hub.example.com");
    expect(text).toStartWith("auth_error: unauthorized");
    expect(text).toContain(formatKeyLookup(lookup));
    expect(text).toContain("agent 'grok-cos'");
    expect(text).toContain("/home/agent/.flair/keys/grok-cos.key (missing)");
    expect(text).toContain("FLAIR_KEY_PATH");
    expect(text).not.toContain("this often follows a Flair daemon restart");
  });

  test("signed 401 names the key file that was used", () => {
    const lookup = {
      agentId: "grok-cos",
      home: "/home/agent",
      candidates: [{ path: "/home/agent/.flair/keys/grok-cos.key", exists: true }],
      resolvedPath: "/home/agent/.flair/keys/grok-cos.key",
      signed: true,
    };
    const err = new FlairError("GET", "/Health", 401, "invalid_signature", lookup);
    const text = classifyError(err, "http://127.0.0.1:19926");
    expect(text).toContain("auth_error: invalid_signature");
    expect(text).toContain("signed with /home/agent/.flair/keys/grok-cos.key");
  });
});
