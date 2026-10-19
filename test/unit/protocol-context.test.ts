/**
 * protocol-context.test.ts — how a protocol-layer call context is recognised
 * (resources/protocol-context.ts), shared by the caller resolver and the
 * table-subscription guard.
 */
import { describe, expect, it } from "bun:test";
import { isMqttSessionContext, isProtocolLayerContext } from "../../resources/protocol-context";

/** A stand-in for Harper's MQTT session object (DurableSubscriptionsSession). */
const session = () => ({ sessionId: "c1", addSubscription: async () => undefined });

describe("isMqttSessionContext", () => {
  it("recognises the context Harper's MQTT session builds, over TCP (no request) and WebSocket", () => {
    expect(isMqttSessionContext({ session: session(), socket: {}, user: {}, authorize: true })).toBe(true);
    expect(isMqttSessionContext({ session: session(), socket: undefined, user: undefined, authorize: false })).toBe(true);
    expect(isMqttSessionContext({ session: session(), socket: {}, request: { headers: {} } })).toBe(true);
  });

  it("does not take any other context for one", () => {
    expect(isMqttSessionContext(undefined)).toBe(false);
    expect(isMqttSessionContext({})).toBe(false);
    expect(isMqttSessionContext({ session: session() })).toBe(false); // no socket key
    expect(isMqttSessionContext({ session: { id: "cookie" }, socket: {} })).toBe(false); // not an MQTT session
    expect(isMqttSessionContext({ session: "s", socket: {} })).toBe(false);
    expect(isMqttSessionContext("context")).toBe(false);
  });
});

describe("isProtocolLayerContext", () => {
  it("is an MQTT session's context or one still carrying authorize: true", () => {
    expect(isProtocolLayerContext({ session: session(), socket: {} })).toBe(true);
    expect(isProtocolLayerContext({ user: {}, authorize: true, request: {} })).toBe(true);
    expect(isProtocolLayerContext({ authorize: false })).toBe(false);
    expect(isProtocolLayerContext({ request: {}, __flairInternal: true })).toBe(false);
    expect(isProtocolLayerContext(null)).toBe(false);
  });
});
