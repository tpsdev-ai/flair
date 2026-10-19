/**
 * protocol-context.test.ts — how a protocol-layer call context is recognised
 * (resources/protocol-context.ts), shared by the caller resolver and the
 * table-subscription guard.
 */
import { describe, expect, it } from "bun:test";
import {
  carriesTransaction,
  isDirectMqttSessionContext,
  isLastWillReplayContext,
  isMqttSessionContext,
  isProtocolLayerContext,
  isReleasedTransactionPlaceholder,
} from "../../resources/protocol-context";

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

describe("isDirectMqttSessionContext", () => {
  it("recognises the plain object Harper's MQTT session builds, and a copy of it", () => {
    const ctx = { session: session(), socket: {}, user: {}, authorize: true };
    expect(isDirectMqttSessionContext(ctx)).toBe(true);
    expect(isDirectMqttSessionContext({ ...ctx, user: { username: "will" } })).toBe(true);
    expect(isDirectMqttSessionContext({ session: session(), socket: undefined })).toBe(true);
    class Session { addSubscription() { return undefined; } } // the method lives on the session's prototype
    expect(isDirectMqttSessionContext({ session: new Session(), socket: {} })).toBe(true);
  });

  it("classifies by shape: an own socket property (an accessor is accepted, not invoked) and an own data session with a data addSubscription", () => {
    let reads = 0;
    const viaAccessorSocket = Object.defineProperty({ session: session() }, "socket", { get() { reads++; return {}; }, enumerable: true });
    expect(isDirectMqttSessionContext(viaAccessorSocket)).toBe(true);
    expect(reads).toBe(0);
  });

  it("is false without that shape (no own socket, a session that is inherited, accessor-held or lacks a data addSubscription), and invokes no getter while deciding", () => {
    let reads = 0;
    const counted = (value: unknown) => ({ get() { reads++; return value; }, enumerable: true });
    expect(isDirectMqttSessionContext(undefined)).toBe(false);
    expect(isDirectMqttSessionContext("context")).toBe(false);
    expect(isDirectMqttSessionContext({ session: session() })).toBe(false); // no socket key
    expect(isDirectMqttSessionContext({ session: { id: "cookie" }, socket: {} })).toBe(false);
    expect(isDirectMqttSessionContext(Object.create({ session: session(), socket: {} }))).toBe(false); // inherited, not own
    expect(isDirectMqttSessionContext(Object.defineProperty({ socket: {} }, "session", counted(session())))).toBe(false);
    expect(isDirectMqttSessionContext({ socket: {}, session: Object.defineProperty({}, "addSubscription", counted(() => undefined)) })).toBe(false);
    expect(isDirectMqttSessionContext({ getContext: () => { reads++; return { session: session(), socket: {} }; } })).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("isLastWillReplayContext", () => {
  /** The context Harper's will replay passes: a copy of the stored will record, with authorize: true. */
  const replayed = () => ({ id: "c1", topic: "Memory/m1", data: { content: "x" }, qos: 1, retain: true, user: { username: "u" }, authorize: true });

  it("recognises the stored will record Harper replays for a retained will", () => {
    expect(isLastWillReplayContext(replayed())).toBe(true);
    expect(isLastWillReplayContext({ ...replayed(), data: undefined, user: undefined })).toBe(true); // an empty will: a delete
  });

  it("is false without that shape (authorize true, a string topic, retain true, each an own data property), and invokes no getter while deciding", () => {
    let reads = 0;
    const counted = (value: unknown) => ({ get() { reads++; return value; }, enumerable: true });
    expect(isLastWillReplayContext(undefined)).toBe(false);
    expect(isLastWillReplayContext({ ...replayed(), retain: false })).toBe(false); // not retained: never a put()/delete()
    expect(isLastWillReplayContext({ ...replayed(), authorize: false })).toBe(false); // Harper already consumed authorize
    expect(isLastWillReplayContext({ ...replayed(), topic: undefined })).toBe(false);
    expect(isLastWillReplayContext({ headers: {}, authorize: true })).toBe(false); // a REST request Harper marked
    expect(isLastWillReplayContext({ user: {}, authorize: true, request: {} })).toBe(false); // Harper's MCP context
    expect(isLastWillReplayContext({ session: session(), socket: {}, authorize: true })).toBe(false); // a session's context
    expect(isLastWillReplayContext(Object.create(replayed()))).toBe(false); // inherited, not own
    for (const key of ["authorize", "topic", "retain"]) {
      const value = replayed() as Record<string, unknown>;
      const held = value[key];
      delete value[key];
      expect(isLastWillReplayContext(Object.defineProperty(value, key, counted(held)))).toBe(false);
    }
    expect(reads).toBe(0);
  });
});

describe("isReleasedTransactionPlaceholder and carriesTransaction", () => {
  // The shape of Harper's RELEASED_TRANSACTION (resources/DatabaseTransaction.ts).
  const released = Object.freeze({
    open: 0, transaction: undefined, writes: Object.freeze([]),
    commit() { return { txnTime: 0 }; }, abort() {}, getReadTxn() {}, addWrite() { throw new Error("released"); }, setContext() { throw new Error("released"); },
  });
  class DatabaseTransactionLike { commit() { return {}; } }

  it("recognises the released-transaction shape and nothing else", () => {
    expect(isReleasedTransactionPlaceholder(released)).toBe(true);
    expect(isReleasedTransactionPlaceholder({ ...released, open: 1 })).toBe(false);
    expect(isReleasedTransactionPlaceholder(new DatabaseTransactionLike())).toBe(false); // methods on the prototype
    expect(isReleasedTransactionPlaceholder({ transaction: {}, user: 1 })).toBe(false);
    expect(isReleasedTransactionPlaceholder(undefined)).toBe(false);
  });

  it("carriesTransaction: an own data transaction with a commit method along its chain", () => {
    expect(carriesTransaction({ transaction: new DatabaseTransactionLike() })).toBe(true);
    expect(carriesTransaction({ transaction: released })).toBe(true); // the shape; Harper's own class test would refuse it
    expect(carriesTransaction({ transaction: { id: 1 } })).toBe(false); // JSON data cannot carry a method
    expect(carriesTransaction(Object.create({ transaction: new DatabaseTransactionLike() }))).toBe(false);
    let reads = 0;
    expect(carriesTransaction(Object.defineProperty({}, "transaction", { get() { reads++; return new DatabaseTransactionLike(); } }))).toBe(false);
    expect(reads).toBe(0);
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
