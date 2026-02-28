import express from "express";
import { authMiddleware } from "./auth.js";
import {
  addIntegration,
  createMemory,
  deleteMemory,
  getAgent,
  getMemory,
  getSoul,
  listAgents,
  listIntegrations,
  listMemories,
  listSouls,
  searchMemories,
  upsertAgent,
  upsertSoul,
} from "./store.js";
import type { Durability } from "./types.js";

export function createApp() {
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(authMiddleware);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/Agent", (_req, res) => res.json(listAgents()));
app.get("/Agent/:id", (req, res) => {
  const row = getAgent(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  return res.json(row);
});
app.post("/Agent", (req, res) => {
  const { id, name, role, publicKey } = req.body || {};
  if (!id || !name || !publicKey) return res.status(400).json({ error: "id_name_publicKey_required" });
  const now = new Date().toISOString();
  const row = upsertAgent({ id, name, role, publicKey, createdAt: now, updatedAt: now });
  return res.status(201).json(row);
});

app.get("/Integration", (req, res) => res.json(listIntegrations(req.query.agentId as string | undefined)));
app.post("/Integration", (req, res) => {
  if (typeof req.body?.credential === "string" || typeof req.body?.token === "string") {
    return res.status(400).json({ error: "plaintext_credentials_forbidden" });
  }

  const { agentId, platform, username, userId, email, encryptedCredential, metadata } = req.body || {};
  if (!agentId || !platform) return res.status(400).json({ error: "agentId_platform_required" });
  if (encryptedCredential && typeof encryptedCredential !== "string") return res.status(400).json({ error: "encryptedCredential_must_be_string" });

  const id = `${agentId}:${platform}`;
  const now = new Date().toISOString();
  const row = addIntegration({ id, agentId, platform, username, userId, email, encryptedCredential, metadata, createdAt: now, updatedAt: now });
  return res.status(201).json(row);
});

// Memory CRUD
app.post("/memory", (req, res) => {
  const { agentId, content, embedding, tags, durability, source, expiresAt } = req.body || {};
  if (!agentId || typeof content !== "string") return res.status(400).json({ error: "agentId_content_required" });
  const row = createMemory({
    agentId,
    content,
    embedding: Array.isArray(embedding) ? embedding : undefined,
    tags: Array.isArray(tags) ? tags : undefined,
    durability: (durability || "standard") as Durability,
    source,
    expiresAt,
  });
  return res.status(201).json(row);
});

app.get("/memory/:id", (req, res) => {
  const row = getMemory(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  return res.json(row);
});

app.get("/memory", (req, res) => {
  return res.json(listMemories({ agentId: req.query.agentId as string | undefined, tag: req.query.tag as string | undefined }));
});

app.delete("/memory/:id", (req, res) => {
  try {
    return res.json(deleteMemory(req.params.id));
  } catch (e: any) {
    if (e.message === "not_found") return res.status(404).json({ error: "not_found" });
    if (e.message === "permanent_memory_cannot_be_deleted") return res.status(403).json({ error: e.message });
    return res.status(400).json({ error: "delete_failed" });
  }
});

app.post("/memory/search", (req, res) => {
  const { agentId, q, tag } = req.body || {};
  return res.json({ results: searchMemories({ agentId, q, tag }) });
});

// Soul CRUD
app.post("/soul", (req, res) => {
  const { id, agentId, key, value, durability } = req.body || {};
  if (!agentId || !key || typeof value !== "string") return res.status(400).json({ error: "agentId_key_value_required" });
  const row = upsertSoul({ id, agentId, key, value, durability: (durability || "permanent") as Durability });
  return res.status(201).json(row);
});

app.get("/soul/:id", (req, res) => {
  const row = getSoul(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  return res.json(row);
});

app.get("/soul", (req, res) => {
  return res.json(listSouls(req.query.agentId as string | undefined));
});

app.put("/soul/:id", (req, res) => {
  const { agentId, key, value, durability } = req.body || {};
  if (!agentId || !key || typeof value !== "string") return res.status(400).json({ error: "agentId_key_value_required" });
  const row = upsertSoul({ id: req.params.id, agentId, key, value, durability: (durability || "permanent") as Durability });
  return res.json(row);
});

return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => {
    console.log(`flair listening on :${port}`);
  });
}
