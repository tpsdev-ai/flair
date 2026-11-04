/**
 * A minimal MQTT 5 client, for tests against a test-Harper whose MQTT path is
 * on (StartHarperOptions.mqttWebSocket): over WebSocket (`open`) or over a TCP
 * listener (`openTcp`).
 *
 * It speaks only what the tests need — CONNECT (optionally with a last-will),
 * SUBSCRIBE, PUBLISH (QoS 0/1, retained or not) and DISCONNECT out; CONNACK,
 * SUBACK, PUBACK and PUBLISH in. It keeps the text of everything the server
 * sent, decoded as UTF-8 (`receivedText`), so a test can scan the stream for
 * an ASCII marker regardless of how Harper encoded a payload (JSON,
 * MessagePack and CBOR all carry a string as its UTF-8 bytes), and, for each
 * inbound PUBLISH, its topic and payload bytes (`publishes`). The raw frames
 * themselves are not kept.
 *
 * MQTT 5 is used, not 3.1.1, because only 5 carries a reason code on SUBACK
 * failures other than 0x80 and on PUBACK at all: a 3.1.1 PUBACK for a refused
 * publish is indistinguishable from success.
 *
 * Packet layouts: OASIS MQTT Version 5.0, sections 2.1 (fixed header), 1.5.5
 * (variable byte integer), 3.1 CONNECT, 3.2 CONNACK, 3.3 PUBLISH, 3.4 PUBACK,
 * 3.8 SUBSCRIBE, 3.9 SUBACK, 3.14 DISCONNECT.
 */
import { createConnection } from "node:net";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** MQTT 5 reason codes the tests name. */
export const MQTT_REASON = Object.freeze({
  SUCCESS: 0x00,
  UNSPECIFIED_ERROR: 0x80,
  BAD_USERNAME_OR_PASSWORD: 0x86,
  NOT_AUTHORIZED: 0x87,
  TOPIC_FILTER_INVALID: 0x8f,
  TOPIC_NAME_INVALID: 0x90,
});

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function mqttString(s: string): number[] {
  const bytes = enc.encode(s);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function packet(firstByte: number, body: number[]): Uint8Array {
  return Uint8Array.from([firstByte, ...varint(body.length), ...body]);
}

function readVarint(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < 4; i++) {
    if (at + i >= buf.length) return null;
    const byte = buf[at + i];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
    multiplier *= 128;
  }
  throw new Error("malformed MQTT variable byte integer");
}

export interface MqttPublishIn {
  topic: string;
  /** The payload as UTF-8 text (lossy for binary encodings; the raw bytes are in `bytes`). */
  text: string;
  bytes: Uint8Array;
}

export type MqttOutcome<T> = { kind: "answered"; value: T } | { kind: "closed"; closeCode?: number } | { kind: "timeout" };

interface MqttTransport {
  opened: Promise<boolean>;
  send: (bytes: Uint8Array) => void;
  close: () => void;
  /** End the connection at once, without a closing handshake on TCP. */
  drop: () => void;
  onData: (cb: (chunk: Uint8Array) => void) => void;
  onClose: (cb: (code: number | undefined) => void) => void;
  protocol: () => string;
}

/** One MQTT connection, over WebSocket (`open`) or TCP (`openTcp`). */
export class MqttClient {
  private transport: MqttTransport;
  private pending = new Uint8Array(0);
  private rawText = "";
  private nextPacketId = 1;
  private waiters: Array<{ match: (type: number, body: Uint8Array) => boolean; resolve: (body: Uint8Array) => void }> = [];
  readonly publishes: MqttPublishIn[] = [];
  closed = false;
  closeCode: number | undefined;
  private closedPromise: Promise<void>;
  private opened: Promise<boolean>;

  private constructor(transport: MqttTransport) {
    this.transport = transport;
    this.closedPromise = new Promise<void>((resolve) => {
      transport.onClose((code) => {
        this.closed = true;
        this.closeCode = code;
        resolve();
      });
    });
    transport.onData((chunk) => this.onData(chunk));
    this.opened = Promise.race([transport.opened, this.closedPromise.then(() => false)]);
  }

  /**
   * Open an MQTT-over-WebSocket connection. `opened` is false when the upgrade
   * failed, the socket closed first, or no open came within `ms`. The `mqtt`
   * subprotocol is what routes
   * the upgrade to Harper's MQTT handler; `protocol` reports what the server
   * negotiated.
   */
  static async open(url: string, authorization?: string, ms = 5_000): Promise<{ client: MqttClient; opened: boolean }> {
    const headers: Record<string, string> = {};
    if (authorization) headers.Authorization = authorization;
    // Bun's WebSocket takes protocols and headers in one options object.
    const ws = new WebSocket(url, { protocols: ["mqtt"], headers } as any);
    ws.binaryType = "arraybuffer";
    const client = new MqttClient({
      opened: new Promise<boolean>((resolve) => {
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("error", () => resolve(false));
      }),
      send: (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); },
      close: () => ws.close(),
      drop: () => ws.close(),
      onData: (cb) => ws.addEventListener("message", (m: MessageEvent) => {
        const d = m.data;
        cb(d instanceof ArrayBuffer ? new Uint8Array(d) : typeof d === "string" ? enc.encode(d) : new Uint8Array(d as ArrayBufferLike));
      }),
      onClose: (cb) => ws.addEventListener("close", (e: CloseEvent) => cb(e.code)),
      protocol: () => ws.protocol,
    });
    const opened = await Promise.race([client.opened, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    return { client, opened };
  }

  /**
   * Open an MQTT connection on a TCP listener (Harper's `mqtt.network.port`).
   * Such a connection carries no HTTP request.
   */
  static async openTcp(host: string, port: number, ms = 5_000): Promise<{ client: MqttClient; opened: boolean }> {
    const socket = createConnection({ host, port });
    const client = new MqttClient({
      opened: new Promise<boolean>((resolve) => {
        socket.once("connect", () => resolve(true));
        socket.once("error", () => resolve(false));
      }),
      send: (bytes) => { if (!socket.destroyed) socket.write(bytes); },
      close: () => socket.end(),
      drop: () => socket.destroy(),
      onData: (cb) => socket.on("data", (d: Buffer) => cb(new Uint8Array(d))),
      onClose: (cb) => socket.once("close", () => cb(undefined)),
      protocol: () => "",
    });
    const opened = await Promise.race([client.opened, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    return { client, opened };
  }

  /** The negotiated WebSocket subprotocol ("mqtt" when Harper's MQTT handler took the upgrade). */
  get protocol(): string {
    return this.transport.protocol();
  }

  /** Everything the server sent, decoded as UTF-8 (for marker scans). */
  get receivedText(): string {
    return this.rawText;
  }

  private onData(chunk: Uint8Array): void {
    this.rawText += dec.decode(chunk, { stream: true });
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    this.pending = merged;
    for (;;) {
      if (this.pending.length < 2) return;
      const len = readVarint(this.pending, 1);
      if (!len) return;
      const end = len.next + len.value;
      if (this.pending.length < end) return;
      const first = this.pending[0];
      const body = this.pending.slice(len.next, end);
      this.pending = this.pending.slice(end);
      this.onPacket(first, body);
    }
  }

  private onPacket(first: number, body: Uint8Array): void {
    const type = first >> 4;
    if (type === 3) {
      const qos = (first >> 1) & 0x03;
      let at = 0;
      const topicLen = (body[at] << 8) | body[at + 1];
      at += 2;
      const topic = dec.decode(body.slice(at, at + topicLen));
      at += topicLen;
      let packetId: number | undefined;
      if (qos > 0) {
        packetId = (body[at] << 8) | body[at + 1];
        at += 2;
      }
      const props = readVarint(body, at);
      if (props) at = props.next + props.value;
      const bytes = body.slice(at);
      this.publishes.push({ topic, text: dec.decode(bytes), bytes });
      if (qos === 1 && packetId !== undefined) this.send(packet(0x40, [packetId >> 8, packetId & 0xff]));
    }
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].match(type, body)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(body);
        return;
      }
    }
  }

  private send(bytes: Uint8Array): void {
    this.transport.send(bytes);
  }

  private await<T>(match: (type: number, body: Uint8Array) => boolean, read: (body: Uint8Array) => T, ms: number): Promise<MqttOutcome<T>> {
    return new Promise<MqttOutcome<T>>((resolve) => {
      const waiter = { match, resolve: (body: Uint8Array) => { clearTimeout(timer); resolve({ kind: "answered", value: read(body) }); } };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve({ kind: "timeout" });
      }, ms);
      this.waiters.push(waiter);
      this.closedPromise.then(() => {
        const at = this.waiters.indexOf(waiter);
        if (at < 0) return;
        this.waiters.splice(at, 1);
        clearTimeout(timer);
        resolve({ kind: "closed", closeCode: this.closeCode });
      });
    });
  }

  /**
   * Send CONNECT (MQTT 5, clean start) and wait for CONNACK: its reason code.
   * `will` registers a last-will message. When the connection ends without
   * DISCONNECT (`drop()`), Harper attempts to publish an eligible will (it
   * skips an expired scoped-token will), and the table guard may refuse it.
   * A `null` payload is zero bytes, which a retained will turns into a delete.
   */
  connect(opts: {
    clientId: string;
    username?: string;
    password?: string;
    will?: { topic: string; payload: unknown; qos?: 0 | 1; retain?: boolean };
    ms?: number;
  }): Promise<MqttOutcome<number>> {
    let flags = 0x02; // clean start
    if (opts.username !== undefined) flags |= 0x80;
    if (opts.password !== undefined) flags |= 0x40;
    const will: number[] = [];
    if (opts.will) {
      flags |= 0x04 | ((opts.will.qos ?? 1) << 3) | (opts.will.retain ? 0x20 : 0);
      const p = opts.will.payload;
      const data = p === null ? [] : [...enc.encode(typeof p === "string" ? p : JSON.stringify(p))];
      // will properties (none), will topic, will payload (two-byte length + bytes)
      will.push(0, ...mqttString(opts.will.topic), data.length >> 8, data.length & 0xff, ...data);
    }
    const body = [
      ...mqttString("MQTT"), 5, flags, 0, 60, // protocol name, level 5, flags, keep alive 60 s
      0, // no properties
      ...mqttString(opts.clientId),
      ...will,
      ...(opts.username !== undefined ? mqttString(opts.username) : []),
      ...(opts.password !== undefined ? mqttString(opts.password) : []),
    ];
    const answer = this.await((type) => type === 2, (b) => b[1], opts.ms ?? 5_000);
    this.send(packet(0x10, body));
    return answer;
  }

  /** Send one SUBSCRIBE carrying every filter and wait for SUBACK: one reason code per filter. */
  subscribe(filters: string[], qos: 0 | 1 = 0, ms = 5_000): Promise<MqttOutcome<number[]>> {
    const id = this.nextPacketId++;
    const body = [id >> 8, id & 0xff, 0];
    for (const f of filters) body.push(...mqttString(f), qos);
    const answer = this.await(
      (type, b) => type === 9 && ((b[0] << 8) | b[1]) === id,
      (b) => {
        const props = readVarint(b, 2)!;
        return [...b.slice(props.next + props.value)];
      },
      ms,
    );
    this.send(packet(0x82, body));
    return answer;
  }

  /**
   * Send PUBLISH. QoS 1 waits for PUBACK and answers its reason code. QoS 0
   * has no acknowledgement: it answers a local placeholder (SUCCESS) after
   * the send attempt, which is evidence neither that the packet was written
   * nor that the server accepted it.
   * `retain: true` sets the RETAIN flag, which Harper turns into a write of the
   * row (a put) — or, with a `null` payload (zero bytes), a delete.
   */
  publish(topic: string, payload: unknown, qos: 0 | 1 = 1, ms = 5_000, opts: { retain?: boolean } = {}): Promise<MqttOutcome<number>> {
    const data = payload === null ? [] : [...enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload))];
    const retain = opts.retain ? 0x01 : 0;
    if (qos === 0) {
      this.send(packet(0x30 | retain, [...mqttString(topic), 0, ...data]));
      return Promise.resolve({ kind: "answered", value: MQTT_REASON.SUCCESS });
    }
    const id = this.nextPacketId++;
    const answer = this.await(
      (type, b) => type === 4 && ((b[0] << 8) | b[1]) === id,
      (b) => (b.length > 2 ? b[2] : MQTT_REASON.SUCCESS),
      ms,
    );
    this.send(packet(0x32 | retain, [...mqttString(topic), id >> 8, id & 0xff, 0, ...data]));
    return answer;
  }

  /**
   * PUBLISH at QoS 1 (retained when `retain`), answering the PUBACK reason
   * code and its reason string (MQTT 5 property 0x1F), if any. For a 403 or
   * 404 refusal Harper truncates the refusal's UTF-8 message at its
   * reason-string limit, then includes the resulting string only when the
   * client has not turned problem information off and it fits the client's
   * maximum packet size (server/mqtt.ts).
   */
  publishDetailed(topic: string, payload: unknown, opts: { retain?: boolean; ms?: number } = {}): Promise<MqttOutcome<{ code: number; reason?: string }>> {
    const data = payload === null ? [] : [...enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload))];
    const id = this.nextPacketId++;
    const answer = this.await(
      (type, b) => type === 4 && ((b[0] << 8) | b[1]) === id,
      (b) => {
        const code = b.length > 2 ? b[2] : MQTT_REASON.SUCCESS;
        let reason: string | undefined;
        if (b.length > 3) {
          const props = readVarint(b, 3);
          if (props) {
            let at = props.next;
            const end = props.next + props.value;
            while (at < end) {
              const prop = b[at++];
              if (prop === 0x1f) {
                const len = (b[at] << 8) | b[at + 1];
                reason = dec.decode(b.slice(at + 2, at + 2 + len));
                at += 2 + len;
              } else if (prop === 0x26) {
                for (let k = 0; k < 2; k++) at += 2 + ((b[at] << 8) | b[at + 1]);
              } else {
                break; // a property this client does not read
              }
            }
          }
        }
        return { code, reason };
      },
      opts.ms ?? 5_000,
    );
    this.send(packet(0x32 | (opts.retain ? 0x01 : 0), [...mqttString(topic), id >> 8, id & 0xff, 0, ...data]));
    return answer;
  }

  /** A retained PUBLISH (QoS 1): Harper writes the row, or deletes it for a `null` payload. */
  publishRetained(topic: string, payload: unknown, ms = 5_000): Promise<MqttOutcome<number>> {
    return this.publish(topic, payload, 1, ms, { retain: true });
  }

  /**
   * Wait until a received PUBLISH matches, `ms` passes, or the connection
   * closes (whichever comes first); undefined when none matched.
   */
  async waitForPublish(pred: (p: MqttPublishIn) => boolean, ms = 10_000): Promise<MqttPublishIn | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = this.publishes.find(pred);
      if (hit) return hit;
      if (this.closed) return undefined;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.publishes.find(pred);
  }

  /**
   * End the connection without DISCONNECT, as a client that dropped would:
   * Harper then attempts to publish the session's will if it is eligible (it
   * skips an expired scoped-token will), and the table guard may refuse it.
   */
  async drop(): Promise<void> {
    try { this.transport.drop(); } catch { /* already closed */ }
    await Promise.race([this.closedPromise, new Promise((r) => setTimeout(r, 2_000))]);
  }

  /** Send DISCONNECT and close the connection. */
  async close(): Promise<void> {
    try { this.send(packet(0xe0, [0, 0])); } catch { /* already closed */ }
    try { this.transport.close(); } catch { /* already closed */ }
    await Promise.race([this.closedPromise, new Promise((r) => setTimeout(r, 2_000))]);
  }
}
