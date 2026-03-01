/**
 * Embeddings provider — calls harper-fabric-embeddings in-process.
 * 
 * Harper v5 blocks node:module even from server.http() middleware context,
 * so we can't import harper-fabric-embeddings directly. We use node:http
 * to call it as an in-process sidecar (started alongside Harper).
 * 
 * TODO: File Harper issue requesting node:module access from server.http()
 * middleware, or a native embeddings extension API.
 */

const MAX_CHARS = 500;
const EMBED_PORT = Number(process.env.FLAIR_EMBED_PORT || "9927");

let dims = 0;
let mode: "sidecar" | "hash" | "none" = "none";

export function getDimensions(): number { return dims; }
export function getMode(): string { return mode; }

async function httpGet(url: string): Promise<string> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res: any) => {
      let data = "";
      res.on("data", (c: any) => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function httpPost(url: string, body: string): Promise<string> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res: any) => {
      let data = "";
      res.on("data", (c: any) => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

export async function initEmbeddings(): Promise<void> {
  // Try sidecar via node:http (Harper blocks fetch globally)
  try {
    const result = await httpGet(`http://127.0.0.1:${EMBED_PORT}/health`);
    const parsed = JSON.parse(result) as { dims: number };
    dims = parsed.dims;
    mode = "sidecar";
    console.log(`[embeddings] Sidecar: ${dims} dims`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] Sidecar not available: ${err.message}`);
  }

  // Fallback: hash-based
  try {
    const { fallbackEmbed } = await import("./embeddings.js");
    dims = 512;
    mode = "hash";
    console.log(`[embeddings] Fallback: ${dims} dims (hash-based)`);
  } catch (e: any) {
    console.error(`[embeddings] Hash fallback failed: ${e.message}`);
  }
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  const truncated = text.slice(0, MAX_CHARS);
  if (mode === "sidecar") {
    try {
      const result = await httpPost(
        `http://127.0.0.1:${EMBED_PORT}/embed`,
        JSON.stringify({ text: truncated })
      );
      return (JSON.parse(result) as { embedding: number[] }).embedding;
    } catch (err: any) {
      console.error(`[embeddings] embed failed: ${err.message}`);
    }
    return null;
  }
  if (mode === "hash") {
    const { fallbackEmbed } = await import("./embeddings.js");
    return fallbackEmbed(truncated);
  }
  return null;
}
