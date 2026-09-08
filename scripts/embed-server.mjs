#!/usr/bin/env node
// Dev-only embedding HTTP server. Uses the in-repo embedding engine directly
// (#1549 absorbed it from the former harper-fabric-embeddings package).
// Imports the COMPILED engine, so run `bun run build` first.
import { EmbeddingEngine } from '../dist/resources/embeddings/engine.js';
import { createServer } from 'node:http';

const PORT = Number(process.env.EMBED_PORT || 9927);
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || '/tmp/flair-models';
const MAX_CHARS = 500; // ~1500 tokens, well under 2048 context

console.log('[embed-server] Initializing model...');
const engine = new EmbeddingEngine({ modelsDir: MODELS_DIR, gpuLayers: 99 });
await engine.ensureReady();
console.log(`[embed-server] Ready — ${engine.dimensions()} dimensions, port ${PORT}`);

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/embed') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const text = (body.text || '').slice(0, MAX_CHARS);
      const { vectors } = await engine.embedMany([text]);
      const embedding = vectors[0] ? Array.from(vectors[0]) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embedding, dims: engine.dimensions() }));
    } catch (err) {
      console.error('[embed-server] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dims: engine.dimensions() }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1');
