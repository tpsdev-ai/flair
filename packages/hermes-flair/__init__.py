"""Flair memory plugin for Hermes — MemoryProvider interface.

Flair is the open-source memory + identity layer for agents. This plugin
makes Flair the durable memory backend for Hermes agents. The plugin
writes under the configured Flair agent ID. Non-admin reads include that
agent’s records and other agents’ non-private records on the instance.

Why Flair specifically:
  - Agent-authored memory (no LLM-driven extraction by default — the agent
    decides what's worth remembering).
  - Self-hosted, no SaaS dependency. Runs on a Mac mini, Mac Studio, a Pi.
  - Ed25519 keys authenticate agents and scope non-admin writes; non-admin
    cross-agent reads of non-private memories are allowed.
  - Flair also stores Soul and Agent records, but this plugin queries Memory
    only.

Config (env vars or $HERMES_HOME/flair.json):
  FLAIR_URL          — Flair server URL (default: http://127.0.0.1:19926)
  FLAIR_AGENT_ID     — Agent identifier (default: hermes)
  FLAIR_KEY_PATH     — Ed25519 private key file
                       (default: ~/.flair/keys/<agent>.key)
                       Accepts a 32-byte raw seed (what `flair agent add`
                       writes), a base64-encoded 32-byte raw seed (44
                        characters), an Ed25519 PEM key, or canonical
                        standard base64 of PKCS8 DER.

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
import re
import threading
import time
import uuid
from urllib.parse import quote
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)


# ─── Config ────────────────────────────────────────────────────────────────

DEFAULT_URL = "http://127.0.0.1:19926"
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
        "Search Flair memories using the configured retrieval mode. Eligible "
        "records include the configured agent’s own memories and other agents’ "
        "non-private memories on this instance. Returns ranked matches up to "
        "the requested limit."
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
                "description": (
                    "Memory durability tier. permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays and is considered before recent rows in bootstrap, subject to scope, expiry/closure and the token budget. persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it). standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days. ephemeral — routine maintenance reaps it once its TTL (24h by default) passes. No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them."
                ),
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

def _format_error(key_path: str) -> ValueError:
    """The named format error: the path and the accepted formats, never the bytes."""
    return ValueError(
        f"flair: could not load an Ed25519 private key from {key_path}: "
          "expected an exact 32-byte raw seed, a base64-encoded 32-byte raw seed, "
          "an Ed25519 PEM key, or canonical standard base64 of PKCS8 DER"
    )


# One PEM block and NOTHING else: BEGIN line, base64 body, END line, anchored.
_PEM_BLOCK_RE = re.compile(
    r"\A-----BEGIN [A-Z0-9 ]+-----\r?\n[A-Za-z0-9+/=\r\n]+-----END [A-Z0-9 ]+-----\Z"
)


def _canonical_base64_decode(text: str):
    """Decode canonical standard base64 (standard alphabet, correctly padded),
    or None. `validate=True` refuses non-alphabet characters and bad padding;
    the re-encode comparison refuses a non-canonical (unpadded/mixed) spelling."""
    try:
        der = base64.b64decode(text, validate=True)
    except Exception:
        return None
    if base64.b64encode(der).decode("ascii") != text:
        return None
    return der


def _load_private_key(key_path: str):
    """Load an Ed25519 private key from a Flair-managed file.

    Checks these formats in order:
      1. An exact 32-byte file is read as a raw Ed25519 seed — the format
         `flair agent add` writes. ANY 32-byte file is read as a raw seed (the
         format is inherently ambiguous at 32 bytes); a 32-byte file is never
         rejected as malformed.
      2. Ed25519 PEM: after outer whitespace is stripped, the WHOLE file must be
         one PEM block (a BEGIN line, a base64 body, an END line). Junk before
         or after the block is refused.
       3. Canonical standard base64 of a 32-byte raw seed or PKCS8 DER key,
         stripped. The encoding must round-trip (standard alphabet, correctly
         padded).

    The base64 branch requires canonical standard base64 after outer whitespace
    is stripped; the decoder decodes text STRICTLY and refuses invalid UTF-8
    bytes (they are never silently cleaned). Unsupported readable non-32-byte
    files raise ValueError naming the path and the accepted formats — never the
    key bytes; file read errors propagate as they are.
    """
    # Import the crypto modules BEFORE reading the key, so an import failure
    # happens while no frame holds key bytes.
    from cryptography.hazmat.primitives import serialization  # noqa: F401
    from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: F401

    data = Path(key_path).read_bytes()  # file READ errors propagate as they are
    key = _parse_private_key(data)
    # The raising frame must not hold the key bytes (a traceback that captures
    # locals would render them), so drop them before any error is raised.
    del data
    if key is None:
        raise _format_error(key_path)
    return key


def _parse_private_key(data: bytes):
    """Parse key bytes per _load_private_key's rules; return the key or None.
    Never raises for a malformed key, so no exception carries this frame."""

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519


    # 1. An exact 32-byte file is a raw seed. ANY 32-byte file: documented, not
    #    a claim that a malformed 32-byte file is rejected.
    if len(data) == 32:
        return ed25519.Ed25519PrivateKey.from_private_bytes(data)

    # Strict UTF-8: invalid bytes that are not an exact 32-byte seed are refused.
    # The decode error holds the file's bytes; it is caught here and never
    # escapes, so nothing is chained or kept as __context__.
    try:
        text = data.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        text = None
    if text is None:
        return None

    # 2. PEM — the WHOLE (whitespace-stripped) file must be one PEM block.
    if text.startswith("-----BEGIN"):
        if _PEM_BLOCK_RE.match(text):
            try:
                key = serialization.load_pem_private_key(text.encode("utf-8"), password=None)
                if isinstance(key, ed25519.Ed25519PrivateKey):
                    return key
            except Exception:
                pass
        return None

    # 3. Canonical standard base64 of a 32-byte raw seed or a PKCS8 DER key.
    #    Order: the 32-byte raw seed first, then PKCS8 DER, matching the
    #    TypeScript loaders (src/lib/auth-resolve.ts and
    #    packages/adk-flair-js/src/signing.ts). A complete Ed25519 PKCS8 DER
    #    key is always longer than 32 bytes (48 in its bare form, more with
    #    optional fields), so it is never taken for a seed.
    der = _canonical_base64_decode(text)
    if der is not None:
        # 3a. base64-encoded raw 32-byte seed (44-char form, like the CLI).
        if len(der) == 32:
            return ed25519.Ed25519PrivateKey.from_private_bytes(der)
        # 3b. PKCS8 DER: the historical Hermes keyfile format. Other decoded
        #     lengths are tried as PKCS8 DER; valid Ed25519 keys load, and
        #     invalid material is refused.
        try:
            key = serialization.load_der_private_key(der, password=None)
            if isinstance(key, ed25519.Ed25519PrivateKey):
                return key
        except Exception:
            pass

    return None

def _sign_request(priv_key, agent_id: str, method: str, path: str) -> str:
    """Build the TPS-Ed25519 Authorization header value."""
    ts = str(int(time.time() * 1000))
    nonce = str(uuid.uuid4())
    payload = f"{agent_id}:{ts}:{nonce}:{method}:{path}".encode("utf-8")
    sig = priv_key.sign(payload)
    sig_b64 = base64.b64encode(sig).decode("ascii")
    return f"TPS-Ed25519 {agent_id}:{ts}:{nonce}:{sig_b64}"


def _encode_record_id(record_id: str) -> str:
    """Percent-encode a Memory id so it addresses exactly that record as ONE
    path segment (flair#1970). REFUSES an id that is exactly ``.`` or ``..``:
    percent-encoding leaves those unchanged and URL normalization collapses
    ``/Memory/.`` to ``/Memory/`` and ``/Memory/..`` to ``/``, so the sent path
    would not be the id (nor the signed path). Such an id cannot address its
    record.
    """
    if record_id in (".", ".."):
        raise ValueError(
            f"record id {record_id!r} is a URL path dot-segment (\".\" or \"..\"); "
            "it cannot be addressed as one path segment of /Memory/<id>. "
            "Use a different id."
        )
    return quote(record_id, safe="")


# ─── Provider implementation ────────────────────────────────────────────────

class FlairMemoryProvider(MemoryProvider):
    """Flair-backed, Ed25519-signed memory with Flair’s visibility-based read scope."""

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
                 "description": "Path to the Ed25519 private key file. `flair agent add` creates a raw 32-byte seed file. Accepted key file formats: a 32-byte raw seed, a base64-encoded 32-byte seed, an Ed25519 PEM key, or canonical standard base64 of PKCS8 DER.",
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

        # Fetch a limited Memory collection without a recency sort, then place
        # returned permanent rows first.
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
            "## Flair memory (collection results)\n\n"
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
        # flair#1987: the request is built ONCE and the signature covers exactly
        # the path that request carries. The client's base URL may have a path
        # (a deployment served under a prefix); httpx merges the route onto it,
        # so signing the built request's own raw path (path + query) can never
        # disagree with what is sent. A base URL that carries a query string or
        # fragment is refused before any request: with a base query, httpx can
        # append the route to the query instead of the path, and a base fragment
        # is carried into the built URL. Refusing both keeps the base a pure path
        # prefix.
        parsed_base = httpx.URL(self._url)
        if "?" in str(parsed_base) or "#" in str(parsed_base):
            raise ValueError(
                f"flair: refusing base URL {self._url!r}: a base URL must not "
                "carry a query string or fragment."
            )
        # _request accepts ROUTES only. A fully qualified URL bypasses the
        # configured base and can address another origin, so a path with a
        # scheme or host is refused before building.
        route = httpx.URL(path)
        if route.scheme or route.host:
            raise ValueError(
                f"flair: refusing {path!r} as a request path: _request "
                "accepts routes (paths), not absolute URLs."
            )
        request = self._http().build_request(method, path, json=json_body)
        request.headers["Authorization"] = _sign_request(
            self._priv_key, self._agent_id, method,
            request.url.raw_path.decode("ascii"),
        )
        resp = self._http().send(request)
        if resp.status_code >= 400:
            raise RuntimeError(f"flair {method} {path} → {resp.status_code} {resp.text[:200]}")
        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            return resp.json()
        return resp.text

    def _fetch_bootstrap(self) -> str:
        """Fetch a limited Memory collection without a recency sort, then place returned permanent rows first."""
        try:
            rows = self._request("GET", f"/Memory/?agentId={self._agent_id}&limit={self._config.get('bootstrap_limit', DEFAULT_BOOTSTRAP_LIMIT)}")
            if not isinstance(rows, list) or not rows:
                return ""
            lines = []
            # Place returned permanent rows before the remaining returned rows; no recency ordering is requested.
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

    def _store_memory(
        self,
        content: str,
        durability: str,
        tags: List[str],
        memory_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if durability not in ("permanent", "persistent", "standard", "ephemeral"):
            durability = "standard"
        # #1970: the id is generated, but a caller may pin it (a test drives the
        # REAL request path with a dot-segment id to prove nothing is sent).
        if memory_id is None:
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
        result = self._request("PUT", f"/Memory/{_encode_record_id(memory_id)}", json_body=body)
        return {"id": memory_id, "result": result}

    # ── Optional hooks ───────────────────────────────────────────────────────

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """For a primary-context Hermes `add`, attempt a persistent Flair write;
        failures are logged and do not update Flair."""
        if not self._is_primary or self._is_breaker_open():
            return
        if action != "add":
            return  # The hook attempts to mirror add operations only; replace and remove remain in Hermes's local files.
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
