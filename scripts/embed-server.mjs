#!/usr/bin/env node
import { init, embed, dimensions } from 'harper-fabric-embeddings';
import { createServer } from 'node:http';

const PORT = Number(process.env.EMBED_PORT || 9927);
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || '/tmp/flair-models';
const MAX_CHARS = 500; // ~1500 tokens, well under 2048 context

console.log('[embed-server] Initializing model...');
await init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
console.log(`[embed-server] Ready — ${dimensions()} dimensions, port ${PORT}`);

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/embed') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const text = (body.text || '').slice(0, MAX_CHARS);
      const embedding = await embed(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embedding, dims: dimensions() }));
    } catch (err) {
      console.error('[embed-server] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dims: dimensions() }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1');
