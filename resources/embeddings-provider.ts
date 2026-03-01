const MAX_CHARS = 500;
const EMBED_URL = process.env.EMBED_URL || "http://127.0.0.1:9927";

let dims = 0;
let mode: "sidecar" | "hash" | "none" = "none";
let hashEmbed: ((text: string) => number[]) | null = null;

export function getDimensions(): number { return dims; }
export function getMode(): string { return mode; }

export async function initEmbeddings(): Promise<void> {
  // Try sidecar
  try {
    console.log(`[embeddings] Trying sidecar at ${EMBED_URL}/health...`);
    const res = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(3000) });
    console.log(`[embeddings] Sidecar response: ${res.status}`);
    if (res.ok) {
      const data = await res.json() as { dims: number };
      dims = data.dims;
      mode = "sidecar";
      console.log(`[embeddings] Sidecar connected: ${dims} dims`);
      return;
    }
  } catch (err: any) {
    console.error(`[embeddings] Sidecar failed: ${err.name}: ${err.message}`);
    if (err.cause) console.error(`[embeddings] Cause: ${err.cause.message || err.cause}`);
  }

  // Try Node's native http module directly
  try {
    console.log("[embeddings] Trying node:http...");
    const http = await import("node:http");
    const result = await new Promise<string>((resolve, reject) => {
      const req = http.get(`${EMBED_URL}/health`, (res: any) => {
        let data = "";
        res.on("data", (c: any) => data += c);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    console.log(`[embeddings] node:http result: ${result}`);
    const parsed = JSON.parse(result) as { dims: number };
    dims = parsed.dims;
    mode = "sidecar";
    console.log(`[embeddings] Sidecar via node:http: ${dims} dims`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] node:http failed: ${err.name}: ${err.message}`);
  }

  // Fallback: hash
  try {
    const { fallbackEmbed } = await import("./embeddings.js");
    dims = 512;
    hashEmbed = fallbackEmbed;
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
      const http = await import("node:http");
      const result = await new Promise<string>((resolve, reject) => {
        const req = http.request(`${EMBED_URL}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }, (res: any) => {
          let data = "";
          res.on("data", (c: any) => data += c);
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
        req.write(JSON.stringify({ text: truncated }));
        req.end();
      });
      const parsed = JSON.parse(result) as { embedding: number[] };
      return parsed.embedding;
    } catch (err: any) {
      console.error(`[embeddings] embed call failed: ${err.message}`);
    }
    return null;
  }
  if (mode === "hash" && hashEmbed) return hashEmbed(truncated);
  return null;
}
