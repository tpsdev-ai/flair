/**
 * mqtt-probe.test.ts — the deploy channel's MQTT-over-WebSocket check
 * (probeMqttOverWebSocket, src/mqtt-off-deploy.ts) against REAL local servers,
 * and the helpers its step relies on: the configuration it requires after
 * setting MQTT off (mqttOffConfirmed) and the operations-URL rules
 * (operationsUrlCredentialProblem, displayUrl).
 *
 * Only a definitive refusal confirms MQTT over WebSocket is off: an HTTP 4xx
 * answer to the upgrade, or a WebSocket close frame instead of a CONNACK. A
 * CONNACK is "served"; a connection error, an HTTP 5xx, a connection that ends
 * without a close frame and a silent server are "inconclusive".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { displayUrl, operationsUrlCredentialProblem, probeMqttOverWebSocket } from "../../src/mqtt-off-deploy.ts";
import { mqttOffConfirmed } from "../../src/lib/mqtt-config.ts";

const servers: Array<{ stop: () => void }> = [];
afterAll(() => { for (const s of servers) s.stop(); });

/** A WebSocket server that answers the first binary message with `onMessage`. */
function wsServer(onMessage: (ws: any) => void) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "mqtt" } })) return undefined as any;
      return new Response("not an upgrade", { status: 400 });
    },
    websocket: { message(ws) { onMessage(ws); } },
  });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
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

describe("probeMqttOverWebSocket", () => {
  test("a CONNACK is served", async () => {
    const url = wsServer((ws) => ws.send(new Uint8Array([0x20, 0x02, 0x00, 0x00])));
    expect(await probeMqttOverWebSocket(url, 3_000)).toEqual({ outcome: "served", detail: "an MQTT CONNACK came back" });
  });

  test("a WebSocket close frame instead of a CONNACK is a definitive refusal", async () => {
    const url = wsServer((ws) => ws.close(1011, "no route"));
    const result = await probeMqttOverWebSocket(url, 3_000);
    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("closed with code 1011");
  });

  test("an HTTP 4xx answer to the upgrade is a definitive refusal", async () => {
    expect((await probeMqttOverWebSocket(httpStatusServer(404), 3_000))).toEqual({ outcome: "refused", detail: "the WebSocket upgrade was answered HTTP 404" });
  });

  test("an HTTP 5xx answer, a 408 or a 429 is inconclusive", async () => {
    for (const status of [502, 503, 408, 429]) {
      expect((await probeMqttOverWebSocket(httpStatusServer(status), 3_000)).outcome, String(status)).toBe("inconclusive");
    }
  });

  test("a server that never answers is inconclusive after the timeout", async () => {
    const url = await tcpServer(() => { /* accept and say nothing */ });
    const result = await probeMqttOverWebSocket(url, 500);
    expect(result).toEqual({ outcome: "inconclusive", detail: "no answer within 500 ms" });
  });

  test("an upgrade followed by the connection ending without a close frame is inconclusive", async () => {
    const url = await tcpServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n");
        socket.once("data", () => socket.end());
      });
    });
    const result = await probeMqttOverWebSocket(url, 3_000);
    expect(result.outcome).toBe("inconclusive");
    expect(result.detail).toContain("without a WebSocket close frame or an MQTT answer");
  });

  test("a connection that is refused is inconclusive", async () => {
    const url = await tcpServer(() => {});
    servers.pop()!.stop(); // nothing listens there now
    await new Promise((r) => setTimeout(r, 50));
    expect((await probeMqttOverWebSocket(url, 2_000)).outcome).toBe("inconclusive");
  });

  test("an answer that is not HTTP is inconclusive", async () => {
    const url = await tcpServer((socket) => socket.once("data", () => socket.write("SSH-2.0-OpenSSH\r\n\r\n")));
    expect((await probeMqttOverWebSocket(url, 2_000)).outcome).toBe("inconclusive");
  });
});

describe("mqttOffConfirmed", () => {
  test("passes Harper's answer after the MQTT-off configuration is set", () => {
    expect(mqttOffConfirmed({ mqtt: { network: { port: null, securePort: null, mtls: false }, webSocket: false, requireAuthentication: true } })).toBeNull();
  });
  test("names what is missing or still on; an empty answer is not off", () => {
    expect(mqttOffConfirmed(null)).toBe("the answer is not a configuration object");
    expect(mqttOffConfirmed({})).toBe("the answer has no mqtt section");
    expect(mqttOffConfirmed({ mqtt: { webSocket: true, network: { port: 1883, securePort: null } } })).toBe("mqtt.webSocket is true, mqtt.network.port is 1883");
    expect(mqttOffConfirmed({ mqtt: { webSocket: false } })).toBe("mqtt.network is missing");
  });
});

describe("operations URL rules", () => {
  test("a URL carrying a user name, a password or a credential in its query or fragment is refused", () => {
    expect(operationsUrlCredentialProblem("https://user:pw@host.example:9925")).toBe("it carries a user name or password");
    expect(operationsUrlCredentialProblem("https://user@host.example:9925")).toBe("it carries a user name or password");
    for (const q of ["token=x", "access_token=x", "api_key=x", "password=x", "auth=x", "sig=x", "X-Amz-Credential=x"]) {
      expect(operationsUrlCredentialProblem(`https://host.example:9925/?${q}`), q).toBe("its query carries a credential parameter");
    }
    expect(operationsUrlCredentialProblem("https://host.example:9925/#token=x")).toBe("its fragment names a credential");
    expect(operationsUrlCredentialProblem("not a url")).toBe("it is not a valid URL");
  });
  test("a plain URL, or one whose query names no credential, is allowed", () => {
    expect(operationsUrlCredentialProblem("https://host.example:9925")).toBeNull();
    expect(operationsUrlCredentialProblem("http://127.0.0.1:19925/")).toBeNull();
    expect(operationsUrlCredentialProblem("https://host.example:9925/?region=eu")).toBeNull();
  });
  test("displayUrl prints the origin and path only", () => {
    expect(displayUrl("https://user:pw@host.example:9925/ops?token=x#y")).toBe("https://host.example:9925/ops?…");
    expect(displayUrl("http://127.0.0.1:19925/")).toBe("http://127.0.0.1:19925");
    expect(displayUrl("::")).toBe("(an unparseable URL)");
  });
});
