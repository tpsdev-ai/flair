/** Exercise boot's real pending window without loading a model or contacting a server. */
import { expect, mock, test } from "bun:test";

const savedLayers = process.env.FLAIR_EMBED_GPU_LAYERS;
process.env.FLAIR_EMBED_GPU_LAYERS = "99";

let announceWarmup!: () => void;
const warmupStarted = new Promise<void>((resolve) => { announceWarmup = resolve; });
let rejectWarmup!: (error: Error) => void;
const warmupGate = new Promise<void>((_, reject) => { rejectWarmup = reject; });

mock.module("harper-fabric-embeddings", () => ({
  register: async () => ({
    ensureReady: async () => {
      announceWarmup();
      await warmupGate;
    },
  }),
}));

const gpu = await import("../../resources/embed-gpu.ts");
await import("../../resources/embeddings-boot.ts");

test("failed warmup stops reporting pending", async () => {
  try {
    await Promise.race([warmupStarted, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("warmup did not start")), 2000))]);
    expect(gpu.getEmbedGpuStatement().pending).toBe(true);

    rejectWarmup(new Error("controlled warmup failure"));
    for (let attempt = 0; attempt < 100 && gpu.getEmbedGpuStatement().pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(gpu.getEmbedGpuStatement()).toEqual({
      backend: "unconfirmed", gpuLayers: null, source: "env",
    });
  } finally {
    gpu._resetEmbedGpuStatementForTests();
    if (savedLayers === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
    else process.env.FLAIR_EMBED_GPU_LAYERS = savedLayers;
  }
});
