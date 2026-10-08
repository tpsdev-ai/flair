import { describe, test, expect } from "bun:test";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { probePortListening } from "../../src/lib/stop-start-recovery.ts";

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("probePortListening (real sockets)", () => {
  test("reports 'listening' for a real server", async () => {
    const srv = createHttpServer(() => {});
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await probePortListening(port)).toBe("listening");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  test("reports 'free' after releasing a loopback listener", async () => {
    const port = await freePort();
    expect(await probePortListening(port)).toBe("free");
  });
});

