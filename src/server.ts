import express from "express";
import { authMiddleware } from "./auth.js";
import { addIntegration, getAgent, listAgents, listIntegrations, upsertAgent } from "./store.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(authMiddleware);

app.get("/health", (_req, res) => res.json({ ok: true }));

// @export-like REST resources
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
  // S31-A: API never accepts plaintext credentials.
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

// Phase 2 placeholder endpoint
app.post("/memory/search", (_req, res) => {
  return res.status(501).json({
    results: [],
    status: "placeholder",
    message: "memory semantic search ships in Phase 2",
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`flair listening on :${port}`);
});
