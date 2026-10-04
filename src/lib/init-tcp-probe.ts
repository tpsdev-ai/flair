import { createConnection } from "node:net";

export async function localPortState(port: number, bindHost: string, connect = createConnection): Promise<"listening" | "free" | "unknown"> {
  const host = ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"].includes(bindHost) ? "127.0.0.1" : bindHost;
  const configured = await tcpPortState(port, host, connect);
  if (host === "127.0.0.1") return configured;
  const loopback = await tcpPortState(port, "127.0.0.1", connect);
  if (configured === "listening" || loopback === "listening") return "listening";
  if (configured === "unknown" || loopback === "unknown") return "unknown";
  return "free";
}

function tcpPortState(port: number, host: string, connect: typeof createConnection): Promise<"listening" | "free" | "unknown"> {
  return new Promise((resolveState) => {
    let socket: ReturnType<typeof createConnection>;
    try {
      socket = connect({ host, port });
    } catch {
      resolveState("unknown");
      return;
    }
    const finish = (state: "listening" | "free" | "unknown"): void => {
      socket.destroy();
      resolveState(state);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "free" : "unknown"));
    socket.once("timeout", () => finish("unknown"));
  });
}
