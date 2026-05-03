"""Flair memory plugin for Hermes — MemoryProvider interface.

Flair is the open-source memory + identity layer for agents. This plugin
makes Flair the durable memory backend for Hermes agents. Per-agent
scoping is preserved: each Hermes agent identity maps to a Flair agentId
and memories are isolated by that agentId end-to-end.

Why Flair specifically:
  - Agent-authored memory (no LLM-driven extraction by default — the agent
    decides what's worth remembering).
  - Self-hosted, no SaaS dependency. Runs on rockit, Mac Studio, a Pi.
  - Ed25519 per-agent signing keys: cross-agent reads are refused by the
    server, not by client convention.
  - Same backend for memory + identity (soul + agent registry), so the
    plugin can answer "who am I and what do I know" from one place.

Config (env vars or $HERMES_HOME/flair.json):
  FLAIR_URL          — Flair server URL (default: http://127.0.0.1:9926)
  FLAIR_AGENT_ID     — Agent identifier (default: hermes)
  FLAIR_KEY_PATH     — PKCS8 base64 private key file
                       (default: ~/.flair/keys/<agent>.key)

Bootstrap a Flair-side identity for this agent:
  1. Install Flair: npm i -g @tpsdev-ai/flair
  2. flair agent add <agent_id>      # creates ~/.flair/keys/<agent_id>.key
  3. flair status                    # confirm server is healthy
  4. hermes memory enable flair      # activates this provider
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)


# ─── Config ────────────────────────────────────────────────────────────────

DEFAULT_URL = "http://127.0.0.1:9926"
DEFAULT_AGENT_ID = "hermes"
DEFAULT_BOOTSTRAP_LIMIT = 10
DEFAULT_RECALL_LIMIT = 5

# Circuit breaker — cap consecutive failures before pausing API calls.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120


def _default_key_path(agent_id: str) -> Path:
    return Path.home() / ".flair" / "keys" / f"{agent_id}.key"


def _load_config() -> dict:
    """Load config from env vars, with $HERMES_HOME/flair.json overrides.

    Env vars provide defaults; flair.json (if present) overrides individual
    keys. Mirrors the pattern used by other Hermes memory plugins.
    """
    from hermes_constants import get_hermes_home

    agent_id = os.environ.get("FLAIR_AGENT_ID", DEFAULT_AGENT_ID)
    config = {
        "url": os.environ.get("FLAIR_URL", DEFAULT_URL).rstrip("/"),
        "agent_id": agent_id,
        "key_path": os.environ.get("FLAIR_KEY_PATH", str(_default_key_path(agent_id))),
        "bootstrap_limit": DEFAULT_BOOTSTRAP_LIMIT,
        "recall_limit": DEFAULT_RECALL_LIMIT,
    }

    config_path = get_hermes_home() / "flair.json"
    if config_path.exists():
        try:
            file_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            for k, v in file_cfg.items():
                if v is not None and v != "":
                    config[k] = v
        except Exception:
            logger.warning("flair.json present but unreadable — using env defaults")

    return config


# ─── Tool schemas ──────────────────────────────────────────────────────────

SEARCH_SCHEMA = {
    "name": "flair_search",
    "description": (
        "Semantic search across this agent's Flair memories. Returns relevant "
        "entries ranked by similarity. Use when the agent needs prior context "
        "from earlier sessions on this topic."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural-language query."},
            "limit": {"type": "integer", "description": "Max results (default: 5, max: 20).",
                      "minimum": 1, "maximum": 20},
        },
        "required": ["query"],
    },
}

STORE_SCHEMA = {
    "name": "flair_store",
    "description": (
        "Persist a memory entry to Flair. Stored verbatim — no LLM extraction. "
        "Use for facts, decisions, preferences, lessons-learned. "
        "Pick durability deliberately: 'permanent' for identity-defining facts "
        "(rare), 'persistent' for important context, 'standard' for general "
        "memories, 'ephemeral' for short-lived context."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "What to remember."},
            "durability": {
                "type": "string",
                "description": "Memory durability tier.",
                "enum": ["permanent", "persistent", "standard", "ephemeral"],
                "default": "standard",
            },
            "tags": {
                "type": "array",
                "description": "Optional tags for grouping (e.g. ['project:hermes', 'topic:auth']).",
                "items": {"type": "string"},
            },
        },
        "required": ["content"],
    },
}


# ─── Ed25519 signing ───────────────────────────────────────────────────────

def _load_private_key(key_path: str):
    """Load PKCS8 base64-encoded Ed25519 key from a Flair-managed file."""
    from cryptography.hazmat.primitives import serialization

    raw = Path(key_path).read_text(encoding="utf-8").strip()
    der = base64.b64decode(raw)
    key = serialization.load_der_private_key(der, password=None)
    return key


def _sign_request(priv_key, agent_id: str, method: str, path: str) -> str:
    """Build the TPS-Ed25519 Authorization header value."""
    ts = str(int(time.time() * 1000))
    nonce = str(uuid.uuid4())
    payload = f"{agent_id}:{ts}:{nonce}:{method}:{path}".encode("utf-8")
    sig = priv_key.sign(payload)
    sig_b64 = base64.b64encode(sig).decode("ascii")
    return f"TPS-Ed25519 {agent_id}:{ts}:{nonce}:{sig_b64}"


# ─── Provider implementation ────────────────────────────────────────────────

class FlairMemoryProvider(MemoryProvider):
    """Flair-backed memory: per-agent-scoped, Ed25519-signed, semantic-searchable."""

    def __init__(self):
        self._config: Optional[dict] = None
        self._url = DEFAULT_URL
        self._agent_id = DEFAULT_AGENT_ID
        self._key_path = ""
        self._priv_key = None
        self._client_lock = threading.Lock()
        self._client = None  # httpx.Client
        # Background prefetch state (next-turn recall)
        self._prefetch_lock = threading.Lock()
        self._prefetch_result = ""
        self._prefetch_thread: Optional[threading.Thread] = None
        # Bootstrap context (one-shot at session start)
        self._bootstrap_text = ""
        # Circuit breaker
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0

    # ── Identity ─────────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "flair"

    def is_available(self) -> bool:
        cfg = _load_config()
        # Available iff a key file exists for the configured agent.
        # We deliberately do NOT touch the network here per the ABC contract.
        try:
            return Path(cfg["key_path"]).exists()
        except Exception:
            return False

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "url",
                "description": "Flair server URL",
                "default": DEFAULT_URL,
                "env_var": "FLAIR_URL",
            },
            {
                "key": "agent_id",
                "description": "Agent identifier (must match `flair agent add <id>`)",
                "default": DEFAULT_AGENT_ID,
                "required": True,
                "env_var": "FLAIR_AGENT_ID",
            },
            {
                "key": "key_path",
                "description": "Path to PKCS8 base64 Ed25519 private key (created by `flair agent add`)",
                "secret": True,
                "env_var": "FLAIR_KEY_PATH",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret config to $HERMES_HOME/flair.json."""
        path = Path(hermes_home) / "flair.json"
        existing = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update({k: v for k, v in values.items() if v is not None and v != ""})
        path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs) -> None:
        self._config = _load_config()
        self._url = self._config["url"]
        self._agent_id = self._config["agent_id"]
        self._key_path = self._config["key_path"]
        try:
            self._priv_key = _load_private_key(self._key_path)
        except Exception as exc:
            logger.error("flair: failed to load private key at %s: %s", self._key_path, exc)
            raise

        agent_context = kwargs.get("agent_context", "primary")
        # Skip writes from non-primary contexts (cron prompts, flush passes)
        # to avoid corrupting the agent's representation of itself.
        self._is_primary = agent_context in ("primary", "")

        # Warm bootstrap: fetch recent + permanent memories synchronously so
        # the first turn's prompt has context. Cheap (single GET).
        self._bootstrap_text = self._fetch_bootstrap()
        logger.info(
            "flair: initialized (agent=%s, url=%s, primary=%s, bootstrap=%d chars)",
            self._agent_id, self._url, self._is_primary, len(self._bootstrap_text),
        )

    def shutdown(self) -> None:
        with self._client_lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass
                self._client = None

    # ── System prompt + recall ───────────────────────────────────────────────

    def system_prompt_block(self) -> str:
        if not self._bootstrap_text:
            return ""
        return (
            "## Flair memory (recent + persistent)\n\n"
            f"{self._bootstrap_text}\n\n"
            "_Use `flair_search <query>` for prior context on a specific topic, "
            "and `flair_store` to persist new facts you want to remember next session._"
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return last-prefetched recall text. The next-turn prefetch is queued
        by `queue_prefetch` after each turn completes."""
        with self._prefetch_lock:
            text = self._prefetch_result
            self._prefetch_result = ""
        return text

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Kick off a background recall for the next turn."""
        if self._is_breaker_open():
            return

        def _do_prefetch():
            try:
                results = self._semantic_search(query, limit=self._config.get("recall_limit", DEFAULT_RECALL_LIMIT))
                if not results:
                    return
                lines = ["## Flair recall (relevant prior context)\n"]
                for r in results:
                    snippet = (r.get("content") or "").replace("\n", " ").strip()[:280]
                    lines.append(f"- {snippet}")
                with self._prefetch_lock:
                    self._prefetch_result = "\n".join(lines)
            except Exception as exc:
                logger.debug("flair prefetch failed: %s", exc)

        # Don't pile up threads; if a prior prefetch is still running, drop this request.
        if self._prefetch_thread is not None and self._prefetch_thread.is_alive():
            return
        self._prefetch_thread = threading.Thread(target=_do_prefetch, daemon=True)
        self._prefetch_thread.start()

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """No-op: Flair memory is agent-authored. The model decides what to
        store via `flair_store`. This avoids the LLM-extraction-on-every-turn
        spam pattern that other backends fall into."""
        return

    # ── Tools ────────────────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, STORE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if self._is_breaker_open():
            return tool_error(
                "flair: circuit breaker open — too many consecutive Flair API failures. "
                "Will retry in a couple minutes."
            )
        try:
            if tool_name == "flair_search":
                results = self._semantic_search(
                    query=args["query"],
                    limit=int(args.get("limit", DEFAULT_RECALL_LIMIT)),
                )
                self._record_success()
                return json.dumps({"results": results})
            if tool_name == "flair_store":
                if not self._is_primary:
                    return json.dumps({"stored": False, "reason": "non-primary agent context — write skipped"})
                stored = self._store_memory(
                    content=args["content"],
                    durability=args.get("durability", "standard"),
                    tags=args.get("tags") or [],
                )
                self._record_success()
                return json.dumps({"stored": True, "id": stored.get("id")})
        except Exception as exc:
            self._record_failure()
            logger.warning("flair: tool '%s' failed: %s", tool_name, exc)
            return tool_error(f"flair: {tool_name} failed: {exc}")

        return tool_error(f"flair: unknown tool '{tool_name}'")

    # ── HTTP plumbing ────────────────────────────────────────────────────────

    def _http(self):
        with self._client_lock:
            if self._client is None:
                import httpx
                self._client = httpx.Client(base_url=self._url, timeout=15.0)
            return self._client

    def _request(self, method: str, path: str, *, json_body: Optional[dict] = None) -> Any:
        if self._priv_key is None:
            raise RuntimeError("flair: provider not initialized")
        auth = _sign_request(self._priv_key, self._agent_id, method, path)
        headers = {"Authorization": auth}
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        resp = self._http().request(method, path, headers=headers, json=json_body)
        if resp.status_code >= 400:
            raise RuntimeError(f"flair {method} {path} → {resp.status_code} {resp.text[:200]}")
        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            return resp.json()
        return resp.text

    def _fetch_bootstrap(self) -> str:
        """Pull the most recent memories + permanent ones for system-prompt seed."""
        try:
            rows = self._request("GET", f"/Memory/?agentId={self._agent_id}&limit={self._config.get('bootstrap_limit', DEFAULT_BOOTSTRAP_LIMIT)}")
            if not isinstance(rows, list) or not rows:
                return ""
            lines = []
            # Permanent first, then recent.
            permanent = [r for r in rows if r.get("durability") == "permanent"]
            recent = [r for r in rows if r.get("durability") != "permanent"]
            for r in (permanent + recent)[: self._config.get("bootstrap_limit", DEFAULT_BOOTSTRAP_LIMIT)]:
                content = (r.get("content") or "").replace("\n", " ").strip()[:280]
                if content:
                    lines.append(f"- {content}")
            return "\n".join(lines)
        except Exception as exc:
            logger.warning("flair: bootstrap fetch failed: %s — system prompt will lack recall context", exc)
            return ""

    def _semantic_search(self, query: str, limit: int = DEFAULT_RECALL_LIMIT) -> List[Dict[str, Any]]:
        body = {"agentId": self._agent_id, "q": query, "limit": min(max(limit, 1), 20)}
        result = self._request("POST", "/SemanticSearch", json_body=body)
        if isinstance(result, dict) and "results" in result:
            return result["results"]
        return []

    def _store_memory(self, content: str, durability: str, tags: List[str]) -> Dict[str, Any]:
        if durability not in ("permanent", "persistent", "standard", "ephemeral"):
            durability = "standard"
        memory_id = f"{self._agent_id}-{int(time.time() * 1000)}"
        body = {
            "id": memory_id,
            "agentId": self._agent_id,
            "content": content,
            "durability": durability,
            "createdAt": _iso_now(),
        }
        if tags:
            body["tags"] = tags
        result = self._request("PUT", f"/Memory/{memory_id}", json_body=body)
        return {"id": memory_id, "result": result}

    # ── Optional hooks ───────────────────────────────────────────────────────

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Mirror Hermes's built-in MEMORY.md/USER.md writes into Flair so the
        agent's permanent recall stays consistent across restarts."""
        if not self._is_primary or self._is_breaker_open():
            return
        if action != "add":
            return  # Replace/remove map awkwardly to Flair's append-only model.
        try:
            tag = f"hermes-builtin:{target}"
            self._store_memory(content=content, durability="persistent", tags=[tag])
            self._record_success()
        except Exception as exc:
            logger.debug("flair: mirror write failed: %s", exc)
            self._record_failure()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Hermes calls this once per session. We deliberately do NOT extract
        with an LLM here — Flair's contract is agent-authored. If the agent
        wanted something stored, it should have used `flair_store` already."""
        return

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Tell the compressor what Flair is contributing so it knows recall
        will survive the compression discard."""
        if self._bootstrap_text:
            return (
                "Flair memory layer is active and will retain agent-authored "
                "facts independently of this conversation's window."
            )
        return ""

    # ── Circuit breaker ──────────────────────────────────────────────────────

    def _is_breaker_open(self) -> bool:
        if self._consecutive_failures < _BREAKER_THRESHOLD:
            return False
        if time.monotonic() >= self._breaker_open_until:
            self._consecutive_failures = 0
            return False
        return True

    def _record_success(self):
        self._consecutive_failures = 0

    def _record_failure(self):
        self._consecutive_failures += 1
        if self._consecutive_failures >= _BREAKER_THRESHOLD:
            self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
            logger.warning(
                "flair circuit breaker tripped after %d failures. Pausing %ds.",
                self._consecutive_failures, _BREAKER_COOLDOWN_SECS,
            )


# ─── Helpers ───────────────────────────────────────────────────────────────

def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
