/**
 * mqtt-probe.test.ts — the deploy channel's MQTT-over-WebSocket check
 * (probeMqttOverWebSocket, src/mqtt-off-deploy.ts) against REAL local servers,
 * and the helpers its step relies on: the configuration it requires after
 * setting MQTT off (mqttOffConfirmed), the check's address (mqttCheckAddress:
 * the operations API URL's host on the HTTP port its configuration names),
 * the URL rules (unsafeUrlProblem, safeUrl, deployUrlRefusal) and the
 * `--require-all-nodes-verified` conflicts (requireAllNodesVerifiedConflict).
 *
 * The check is authenticated with the deploy's credential and validates the
 * upgrade (101, a Sec-WebSocket-Accept matching the key, the mqtt
 * subprotocol). Only Harper's own answer for a disabled MQTT-over-WebSocket
 * path — the upgrade closed with code 1011 and "No resource was found to
 * handle <path>" — is "off"; test/integration/mqtt-off-deploy-doctor.test.ts
 * pins that against a real Harper. A CONNACK is "served". Everything else is
 * "inconclusive": an authentication denial or any other HTTP status, any other
 * close, an upgrade answer that does not validate, a connection error, a
 * connection that ends, and a silent server.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { deployUrlRefusal, mqttCheckAddress, probeMqttOverWebSocket, requireAllNodesVerifiedConflict, safeUrl, unsafeUrlProblem } from "../../src/mqtt-off-deploy.ts";
import { mqttOffConfirmed } from "../../src/lib/mqtt-config.ts";

const servers: Array<{ stop: () => void }> = [];
afterAll(() => { for (const s of servers) s.stop(); });

const CREDS = { user: "admin", password: "probe-test-not-a-secret" };
const BASIC = `Basic ${Buffer.from(`${CREDS.user}:${CREDS.password}`).toString("base64")}`;
const CONNACK = new Uint8Array([0x20, 0x02, 0x00, 0x00]);

/**
 * A WebSocket server that admits an upgrade when `admit` says so (else answers
 * 401), echoes the mqtt subprotocol, and then runs `behave` on the socket:
 * on open (`onOpen`) or on the first message (`onMessage`). Records the
 * Authorization header of each upgrade.
 */
function wsServer(opts: { admit?: (auth: string | null) => boolean; onOpen?: (ws: any) => void; onMessage?: (ws: any) => void }) {
  const seen: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const auth = req.headers.get("authorization");
      seen.push(auth);
      if (opts.admit && !opts.admit(auth)) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "mqtt" } })) return undefined as any;
      return new Response("not an upgrade", { status: 400 });
    },
    websocket: {
      open(ws) { opts.onOpen?.(ws); },
      message(ws) { opts.onMessage?.(ws); },
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function httpStatusServer(status: number) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status }) });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

/** A raw TCP server whose connection handler decides what the check sees. */
async function tcpServer(onConnection: (socket: Socket) => void): Promise<string> {
  const server: Server = createServer(onConnection);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push({ stop: () => server.close() });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

/** A raw 101 answer to `req`: a correct Sec-WebSocket-Accept unless `accept` is given, and the mqtt subprotocol unless `protocol` is false. */
function upgradeAnswer(req: Buffer, o: { accept?: string; protocol?: boolean } = {}): string {
  const key = /Sec-WebSocket-Key: (\S+)/i.exec(req.toString())![1];
  const accept = o.accept ?? createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${o.protocol === false ? "" : "Sec-WebSocket-Protocol: mqtt\r\n"}\r\n`;
}

/** Harper's close frame for a disabled MQTT-over-WebSocket path, as raw bytes. */
function harperOffFrame(): Buffer {
  const reason = Buffer.from("No resource was found to handle /");
  return Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x03, 0xf3]), reason]);
}

/** Harper's answer for a disabled MQTT-over-WebSocket path (measured against a real Harper). */
const harperOff = (path = "/") => (ws: any) => ws.close(1011, `No resource was found to handle ${path}`);

describe("probeMqttOverWebSocket", () => {
  test("Harper's answer for a disabled MQTT-over-WebSocket path, to an authenticated and validated upgrade, is off", async () => {
    const { url, seen } = wsServer({ onOpen: harperOff() });
    const result = await probeMqttOverWebSocket(url, { ...CREDS, timeoutMs: 3_000 });
    expect(result.outcome).toBe("off");
    expect(seen).toEqual([BASIC]); // the deploy's credential rides on the upgrade request
  });

  test("a CONNACK is served", async () => {
    const { url } = wsServer({ onMessage: (ws) => ws.send(CONNACK) });
    expect(await probeMqttOverWebSocket(url, { ...CREDS, timeoutMs: 3_000 })).toEqual({ outcome: "served", detail: "an MQTT CONNACK came back" });
  });

  test("a gateway that refuses the anonymous upgrade but admits the authenticated one is served, never off", async () => {
    const gateway = () => wsServer({ admit: (auth) => auth === BASIC, onMessage: (ws) => ws.send(CONNACK) });
    const authenticated = gateway();
    expect((await probeMqttOverWebSocket(authenticated.url, { ...CREDS, timeoutMs: 3_000 })).outcome).toBe("served");
    const anonymous = gateway();
    const denied = await probeMqttOverWebSocket(anonymous.url, 3_000);
    expect(denied).toEqual({ outcome: "inconclusive", detail: "the WebSocket upgrade was answered HTTP 401" });
  });

  test("any other close is inconclusive: an authentication denial, a normal close, the off answer for another path", async () => {
    for (const [what, onOpen] of [
      ["Harper's login failure", (ws: any) => ws.close(3000, "Login failed")],
      ["a normal close", (ws: any) => ws.close(1000, "bye")],
      ["1011 for another path", harperOff("/elsewhere")],
      ["1011 with another reason", (ws: any) => ws.close(1011, "internal error")],
    ] as const) {
      const { url } = wsServer({ onOpen });
      const result = await probeMqttOverWebSocket(url, { ...CREDS, timeoutMs: 3_000 });
      expect([what, result.outcome]).toEqual([what, "inconclusive"]);
      expect(result.detail).not.toContain("Login failed"); // never the server's text
    }
  });

  test("any HTTP answer other than 101 is inconclusive, 4xx included", async () => {
    for (const status of [401, 403, 404, 400, 408, 429, 502, 503]) {
      expect([status, (await probeMqttOverWebSocket(httpStatusServer(status), { ...CREDS, timeoutMs: 3_000 })).outcome]).toEqual([status, "inconclusive"]);
    }
  });

  test("an upgrade answer that does not validate is inconclusive: a wrong Sec-WebSocket-Accept, no mqtt subprotocol", async () => {
    // Each answer is followed by Harper's off frame, which must not count after an upgrade that did not validate.
    const wrongAccept = await tcpServer((socket) => {
      socket.once("data", (req: Buffer) => socket.write(Buffer.concat([Buffer.from(upgradeAnswer(req, { accept: "x" })), harperOffFrame()])));
    });
    expect((await probeMqttOverWebSocket(wrongAccept, { ...CREDS, timeoutMs: 3_000 })).detail).toContain("did not validate");
    const noProtocol = await tcpServer((socket) => {
      socket.once("data", (req: Buffer) => socket.write(Buffer.concat([Buffer.from(upgradeAnswer(req, { protocol: false })), harperOffFrame()])));
    });
    expect((await probeMqttOverWebSocket(noProtocol, { ...CREDS, timeoutMs: 3_000 })).detail).toContain("did not validate");
    // The same raw answer with a valid upgrade is off: the frame encoding above is Harper's.
    const valid = await tcpServer((socket) => {
      socket.once("data", (req: Buffer) => socket.write(Buffer.concat([Buffer.from(upgradeAnswer(req)), harperOffFrame()])));
    });
    expect((await probeMqttOverWebSocket(valid, { ...CREDS, timeoutMs: 3_000 })).outcome).toBe("off");
  });

  test("a validated upgrade followed by the connection ending without a close frame is inconclusive", async () => {
    const url = await tcpServer((socket) => {
      socket.once("data", (req: Buffer) => {
        socket.write(upgradeAnswer(req));
        socket.once("data", () => socket.end());
      });
    });
    const result = await probeMqttOverWebSocket(url, { ...CREDS, timeoutMs: 3_000 });
    expect(result).toEqual({ outcome: "inconclusive", detail: "the connection ended without a close frame or an MQTT answer" });
  });

  test("a server that never answers, a refused connection and an answer that is not HTTP are inconclusive", async () => {
    const silent = await tcpServer(() => { /* accept and say nothing */ });
    expect(await probeMqttOverWebSocket(silent, { ...CREDS, timeoutMs: 500 })).toEqual({ outcome: "inconclusive", detail: "no answer within 500 ms" });
    const gone = await tcpServer(() => {});
    servers.pop()!.stop(); // nothing listens there now
    await new Promise((r) => setTimeout(r, 50));
    expect((await probeMqttOverWebSocket(gone, { ...CREDS, timeoutMs: 2_000 })).outcome).toBe("inconclusive");
    const ssh = await tcpServer((socket) => socket.once("data", () => socket.write("SSH-2.0-OpenSSH\r\n\r\n")));
    expect((await probeMqttOverWebSocket(ssh, { ...CREDS, timeoutMs: 2_000 })).outcome).toBe("inconclusive");
  });

  test("a URL that may not be used is not probed", async () => {
    for (const url of ["http://127.0.0.1:1/?token=x", "file:///tmp/private-value", "javascript:private-value", "ftp://127.0.0.1:1/"]) {
      expect([url, await probeMqttOverWebSocket(url, CREDS)]).toEqual([url, { outcome: "inconclusive", detail: "the URL to check may not be used" }]);
    }
  });
});

describe("mqttOffConfirmed", () => {
  test("passes Harper's answer after the MQTT-off configuration is set", () => {
    expect(mqttOffConfirmed({ mqtt: { network: { port: null, securePort: null, mtls: false }, webSocket: false, requireAuthentication: true } })).toBeNull();
  });
  test("names what is missing or still on; an empty answer is not off", () => {
    expect(mqttOffConfirmed(null)).toBe("the answer is not a configuration object");
    expect(mqttOffConfirmed({})).toBe("the answer has no mqtt section");
    expect(mqttOffConfirmed({ mqtt: { webSocket: true, network: { port: 1883, securePort: null } } })).toBe("mqtt.webSocket is not false, mqtt.network.port is not null");
    expect(mqttOffConfirmed({ mqtt: { webSocket: false } })).toBe("mqtt.network is missing");
    expect(mqttOffConfirmed({ mqtt: { network: {} } })).toBe("mqtt.webSocket is missing, mqtt.network.port is missing, mqtt.network.securePort is missing");
  });
  test("reports field names and categories only, never a value the answer carries", () => {
    const reason = mqttOffConfirmed({ mqtt: { webSocket: "private-value", network: { port: "private-value", securePort: { v: "private-value" } } } });
    expect(reason).toBe("mqtt.webSocket is not false, mqtt.network.port is not null, mqtt.network.securePort is not null");
    expect(reason).not.toContain("private-value");
  });
});

describe("mqttCheckAddress: the operations API URL's host, on the HTTP port its configuration names", () => {
  const cfg = (http: Record<string, unknown>) => ({ http, mqtt: {} });
  test("http.port over http; http.securePort over https; when both are set, the one matching the operations API URL's scheme", () => {
    expect(mqttCheckAddress("http://node-a.example:9925", cfg({ port: 9926, securePort: null }))).toEqual({ url: "http://node-a.example:9926" });
    expect(mqttCheckAddress("https://node-a.example:9925", cfg({ port: 9926, securePort: null }))).toEqual({ url: "http://node-a.example:9926" });
    expect(mqttCheckAddress("http://node-a.example:9925", cfg({ port: null, securePort: 9927 }))).toEqual({ url: "https://node-a.example:9927" });
    expect(mqttCheckAddress("http://node-a.example:9925", cfg({ port: 9926, securePort: 9927 }))).toEqual({ url: "http://node-a.example:9926" });
    expect(mqttCheckAddress("https://node-a.example:9925", cfg({ port: 9926, securePort: 9927 }))).toEqual({ url: "https://node-a.example:9927" });
    // Harper's "host:port" form, and an IPv6 host.
    expect(mqttCheckAddress("http://127.0.0.1:9925", cfg({ port: "127.0.0.1:19926" }))).toEqual({ url: "http://127.0.0.1:19926" });
    expect(mqttCheckAddress("http://[::1]:9925", cfg({ port: 9926 }))).toEqual({ url: "http://[::1]:9926" });
  });
  test("a configuration that names no usable HTTP port gives no address", () => {
    for (const config of [{}, null, cfg({}), cfg({ port: null, securePort: null }), cfg({ port: "private-value" })]) {
      const answer = mqttCheckAddress("http://node-a.example:9925", config);
      expect([JSON.stringify(config), "problem" in answer]).toEqual([JSON.stringify(config), true]);
      expect(JSON.stringify(answer)).not.toContain("private-value");
    }
  });
  test("a check URL is used only when it names the same host (any case) and a configured HTTP port; its scheme is kept", () => {
    const config = cfg({ port: 9926, securePort: 9927 });
    expect(mqttCheckAddress("http://Node-A.example:9925", config, "wss://node-a.EXAMPLE:9927/")).toEqual({ url: "wss://node-a.EXAMPLE:9927/" });
    expect(mqttCheckAddress("http://node-a.example:9925", config, "ws://node-a.example:9926")).toEqual({ url: "ws://node-a.example:9926" });
    // The scheme's default port counts as the URL's port.
    expect(mqttCheckAddress("https://node-a.example:9925", cfg({ securePort: 443 }), "https://node-a.example/")).toEqual({ url: "https://node-a.example/" });
    for (const check of ["http://node-b.example:9926", "http://node-a.example:9928", "https://node-a.example/", "http://10.0.0.5:9926"]) {
      const answer = mqttCheckAddress("http://node-a.example:9925", config, check);
      expect([check, "problem" in answer]).toEqual([check, true]);
      expect((answer as { problem: string }).problem).toContain("does not name the operations API URL's host (node-a.example) and an HTTP port that host's configuration names");
    }
  });
});

describe("requireAllNodesVerifiedConflict", () => {
  test("refuses --require-all-nodes-verified with each option that skips the post-restart check, and with --verify-mqtt-only", () => {
    for (const [over, flag] of [
      [{ verify: false }, "--no-verify"],
      [{ restart: false }, "--no-restart"],
      [{ keepMqttConfig: true }, "--keep-mqtt-config"],
      [{ verifyMqttOnly: true }, "--verify-mqtt-only"],
    ] as const) {
      const message = requireAllNodesVerifiedConflict({ requireAllNodesVerified: true, ...over });
      expect([flag, message?.includes(`cannot be combined with ${flag}`)]).toEqual([flag, true]);
      expect(message).toContain("Nothing was deployed or sent");
    }
    expect(requireAllNodesVerifiedConflict({ requireAllNodesVerified: true, verify: false, restart: false })).toContain("cannot be combined with --no-verify, --no-restart");
  });
  test("is null without the requirement, or with nothing that skips the check", () => {
    expect(requireAllNodesVerifiedConflict({ verify: false, restart: false, keepMqttConfig: true, verifyMqttOnly: true })).toBeNull();
    expect(requireAllNodesVerifiedConflict({ requireAllNodesVerified: true })).toBeNull();
    expect(requireAllNodesVerifiedConflict({ requireAllNodesVerified: true, verify: true, restart: true, keepMqttConfig: false })).toBeNull();
  });
});

describe("URL rules", () => {
  test("a URL carrying a user name or password, any query or any fragment is refused", () => {
    expect(unsafeUrlProblem("https://user:pw@host.example:9925")).toBe("it carries a user name or password");
    expect(unsafeUrlProblem("https://user@host.example:9925")).toBe("it carries a user name or password");
    for (const q of ["token=x", "value=mysecret", "region=eu", "x"]) {
      expect([q, unsafeUrlProblem(`https://host.example:9925/?${q}`)]).toEqual([q, "it carries a query"]);
    }
    expect(unsafeUrlProblem("https://host.example:9925/?")).toBe("it carries a query");
    expect(unsafeUrlProblem("https://host.example:9925/#anything")).toBe("it carries a fragment");
    expect(unsafeUrlProblem("not a url")).toBe("it is not a valid URL");
  });
  test("scheme, host, port and path only is allowed", () => {
    expect(unsafeUrlProblem("https://host.example:9925")).toBeNull();
    expect(unsafeUrlProblem("http://127.0.0.1:19925/")).toBeNull();
    expect(unsafeUrlProblem("https://host.example/flair")).toBeNull();
    expect(unsafeUrlProblem("wss://host.example:9926/", "check")).toBeNull();
    expect(unsafeUrlProblem("ws://127.0.0.1:19926", "check")).toBeNull();
    expect(unsafeUrlProblem("http://127.0.0.1:19926", "check")).toBeNull();
  });
  test("a scheme other than http or https (or, for the check URL, ws or wss), or a URL without a host, is refused", () => {
    for (const url of ["file:///tmp/private-value", "javascript:private-value", "ftp://host.example/", "data:text/plain,private-value", "mailto:someone@host.example"]) {
      expect([url, unsafeUrlProblem(url)]).toEqual([url, "its scheme is not http or https"]);
      expect([url, unsafeUrlProblem(url, "check")]).toEqual([url, "its scheme is not http, https, ws or wss"]);
    }
    expect(unsafeUrlProblem("ws://host.example:9926")).toBe("its scheme is not http or https");
    expect(unsafeUrlProblem("wss://host.example:9926")).toBe("its scheme is not http or https");
  });
  test("safeUrl prints scheme, host, port and path only, and only for an http, https, ws or wss URL with a host", () => {
    expect(safeUrl("https://user:pw@host.example:9925/ops?token=x#y")).toBe("https://host.example:9925/ops");
    expect(safeUrl("http://127.0.0.1:19925/")).toBe("http://127.0.0.1:19925");
    expect(safeUrl("wss://127.0.0.1:19926/")).toBe("wss://127.0.0.1:19926");
    expect(safeUrl("::")).toBe("(an unparseable URL)");
    for (const url of ["file:///tmp/private-value", "javascript:private-value"]) {
      expect([url, safeUrl(url)]).toEqual([url, "(a URL that is not http, https, ws or wss with a host)"]);
    }
  });
  test("deployUrlRefusal names the first URL that may not be used, showing it only through safeUrl", () => {
    const refusal = deployUrlRefusal([
      ["https://host.example:9925", "deploy target URL (--target)"],
      [undefined, "skipped"],
      ["https://user:hunter2@host.example:9925/?token=abc", "operations API URL"],
    ]);
    expect(refusal).toContain("the operations API URL https://host.example:9925 cannot be used: it carries a user name or password");
    expect(refusal).not.toContain("hunter2");
    expect(refusal).not.toContain("token=abc");
    expect(deployUrlRefusal([["https://host.example", "deploy target URL"]])).toBeNull();
  });
  test("deployUrlRefusal applies each URL's grammar and never prints a refused URL's text", () => {
    expect(deployUrlRefusal([["wss://host.example:9926", "URL the MQTT check reaches", "check"]])).toBeNull();
    const refusal = deployUrlRefusal([["wss://host.example:9926", "operations API URL"]]);
    expect(refusal).toContain("the operations API URL wss://host.example:9926 cannot be used: its scheme is not http or https");
    for (const [url, kind] of [["javascript:private-value", "http"], ["file:///tmp/private-value", "check"]] as const) {
      const message = deployUrlRefusal([[url, "URL", kind]]);
      expect(message).toContain("cannot be used: its scheme is not");
      expect(message).not.toContain("private-value");
    }
  });
});
