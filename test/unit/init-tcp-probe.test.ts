import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { localPortState } from "../../src/lib/init-tcp-probe.js";

function connector(outcomes: Record<string, string>) {
  const hosts: string[] = [];
  let closed = 0;
  const connect = (({ host }: { host: string }) => {
    hosts.push(host);
    const socket = new EventEmitter();
    Object.assign(socket, { setTimeout: () => {}, destroy: () => { closed++; } });
    queueMicrotask(() => {
      const outcome = outcomes[host];
      if (outcome === "connect" || outcome === "timeout") socket.emit(outcome);
      else socket.emit("error", Object.assign(new Error("fixture"), { code: outcome }));
    });
    return socket;
  }) as unknown as typeof createConnection;
  return { connect, hosts, closed: () => closed };
}

for (const host of ["127.0.0.1", "0.0.0.0", "::"]) {
  test(`free ${host} checks IPv4 loopback and closes its socket`, async () => {
    const fake = connector({ "127.0.0.1": "ECONNREFUSED" });
    expect(await localPortState(20991, host, fake.connect)).toBe("free");
    expect(fake.hosts).toEqual(["127.0.0.1"]);
    expect(fake.closed()).toBe(1);
  });
}

for (const outcome of ["connect", "timeout", "EACCES"]) {
  test(`a free configured host cannot hide a loopback ${outcome}`, async () => {
    const fake = connector({ "127.0.0.2": "ECONNREFUSED", "127.0.0.1": outcome });
    expect(await localPortState(20991, "127.0.0.2", fake.connect)).toBe(outcome === "connect" ? "listening" : "unknown");
    expect(fake.hosts).toEqual(["127.0.0.2", "127.0.0.1"]);
    expect(fake.closed()).toBe(2);
  });
}

test("a synchronous connect failure remains unknown", async () => {
  const connect = (() => { throw new Error("fixture"); }) as typeof createConnection;
  expect(await localPortState(20991, "127.0.0.1", connect)).toBe("unknown");
});
