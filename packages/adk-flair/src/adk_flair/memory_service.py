"""FlairMemoryService — Flair as the memory backend for Google ADK.

Implements BaseMemoryService so ADK agents persist long-term memory into a
Flair instance, getting crypto-pinned per-agent identity, federated peer-to-peer
sync, and cross-orchestrator portability. The same memories are visible to any
other Flair-enabled harness (Claude Code, Gemini CLI, Hermes, OpenClaw, n8n).

Usage:
    from adk_flair import FlairMemoryService

    memory_service = FlairMemoryService(
        url="http://localhost:19926",
        agent_id="my-adk-app",
        keyfile="/home/agent/.flair/keys/my-adk-app.key",
    )

    # Or via the flair:// URI scheme (requires services.py registration):
    # adk web --memory_service_uri="flair://localhost:19926"
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from google.adk.memory import BaseMemoryService
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.memory.base_memory_service import SearchMemoryResponse
from google.adk.sessions import Session
from google.genai import types

logger = logging.getLogger("adk_flair")

# ─── Constants ──────────────────────────────────────────────────────────────

_LOCALHOST_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})
_ALLOW_REMOTE_ENV = "FLAIR_ALLOW_REMOTE_URL"
_TAG_PREFIX = "adk"

# ─── Helpers ────────────────────────────────────────────────────────────────


def _sanitize_tag_segment(value: str) -> str:
    """Replace colons in a tag segment so the compound tag delimiter is unambiguous."""
    return value.replace(":", "_")


def _compound_tag(app_name: str, user_id: str) -> str:
    """Build the compound scope tag: adk:<app>:<user>."""
    return f"{_TAG_PREFIX}:{_sanitize_tag_segment(app_name)}:{_sanitize_tag_segment(user_id)}"


def _deterministic_record_id(
    app_name: str, user_id: str, session_id: str, event_id: str
) -> str:
    """Deterministic record id for idempotent re-ingestion."""
    return f"{app_name}:{user_id}:{session_id}:{event_id}"


def _iso_now() -> str:
    """ISO 8601 timestamp with millisecond precision in UTC."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    )


def _load_ed25519_key(keyfile: str) -> ed25519.Ed25519PrivateKey:
    """Load a PKCS8 base64-encoded Ed25519 private key from a Flair-managed keyfile.

    Raises ValueError with the env-var name (never the filesystem path) on failure.
    """
    try:
        raw = Path(keyfile).read_text(encoding="utf-8").strip()
        der = base64.b64decode(raw)
        key = serialization.load_der_private_key(der, password=None)
        if not isinstance(key, ed25519.Ed25519PrivateKey):
            raise ValueError(
                f"FLAIR_KEYFILE does not contain an Ed25519 key "
                f"(got {type(key).__name__})"
            )
        return key
    except FileNotFoundError:
        raise ValueError(
            "FLAIR_KEYFILE points to a file that does not exist"
        ) from None
    except (base64.binascii.Error, ValueError) as exc:
        if isinstance(exc, ValueError) and "FLAIR_KEYFILE" in str(exc):
            raise
        raise ValueError(
            "FLAIR_KEYFILE does not contain a valid PKCS8 base64-encoded Ed25519 key"
        ) from exc


def _sign_request(
    private_key: ed25519.Ed25519PrivateKey,
    agent_id: str,
    method: str,
    path: str,
) -> str:
    """Build the TPS-Ed25519 Authorization header value."""
    ts = str(int(time.time() * 1000))
    nonce = str(uuid.uuid4())
    payload = f"{agent_id}:{ts}:{nonce}:{method}:{path}".encode("utf-8")
    sig = private_key.sign(payload)
    sig_b64 = base64.b64encode(sig).decode("ascii")
    return f"TPS-Ed25519 {agent_id}:{ts}:{nonce}:{sig_b64}"


def _is_localhost(host: str) -> bool:
    """Check whether a host string is a localhost address."""
    return host.lower() in _LOCALHOST_HOSTS


# ─── FlairMemoryService ─────────────────────────────────────────────────────


class FlairMemoryService(BaseMemoryService):
    """Flair-backed memory service for Google ADK.

    All users of one ADK app share one Flair principal. Per-user isolation is
    enforced by tag-based server-side filtering, not cryptographic key
    separation. See the README Security section for details.

    Constructor args (all optional; env vars provide defaults):
        url: Flair server URL. Default: FLAIR_URL or http://localhost:19926
        agent_id: Flair agent identity. Default: FLAIR_AGENT_ID
        keyfile: Path to PKCS8 base64 Ed25519 key. Default: FLAIR_KEYFILE
    """

    def __init__(
        self,
        url: Optional[str] = None,
        agent_id: Optional[str] = None,
        keyfile: Optional[str] = None,
    ):
        # Resolve URL
        raw_url = (url or os.environ.get("FLAIR_URL", "http://localhost:19926")).rstrip("/")
        parsed = urlparse(raw_url)

        # URL protection: localhost constructs freely; remote needs explicit opt-in
        if not _is_localhost(parsed.hostname or ""):
            if os.environ.get(_ALLOW_REMOTE_ENV) != "1":
                raise ValueError(
                    f"FLAIR_URL ({raw_url}) is not a localhost address. "
                    f"Set {_ALLOW_REMOTE_ENV}=1 to allow remote Flair URLs."
                )

        self._url = raw_url
        self._agent_id = agent_id or os.environ.get("FLAIR_AGENT_ID", "")
        if not self._agent_id:
            raise ValueError("FLAIR_AGENT_ID is required (set env var or pass agent_id)")

        # Resolve and validate keyfile in the constructor — deferring to first
        # use lands the failure inside ADK's exception-swallowing search path.
        resolved_keyfile = keyfile or os.environ.get("FLAIR_KEYFILE", "")
        if not resolved_keyfile:
            raise ValueError("FLAIR_KEYFILE is required (set env var or pass keyfile)")
        self._private_key = _load_ed25519_key(resolved_keyfile)

        # httpx client — created lazily on first request
        self._client: Optional[httpx.AsyncClient] = None

        # Per-session state for custom_metadata warn-once
        self._warned_sessions: set[str] = set()

        # First-request URL logging gate
        self._url_logged = False

    # ── HTTP plumbing ────────────────────────────────────────────────────────

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._url,
                timeout=httpx.Timeout(connect=0.5, read=1.5, write=1.0, pool=0.5),
            )
        return self._client

    async def _request(
        self, method: str, path: str, *, json_body: Optional[dict] = None
    ) -> Any:
        """Make an authenticated request to Flair. One attempt, no retry."""
        if not self._url_logged:
            logger.warning("adk-flair: using Flair at %s (agent=%s)", self._url, self._agent_id)
            self._url_logged = True

        auth = _sign_request(self._private_key, self._agent_id, method, path)
        headers = {"Authorization": auth}
        if json_body is not None:
            headers["Content-Type"] = "application/json"

        t0 = time.monotonic()
        try:
            resp = await self._http.request(method, path, headers=headers, json=json_body)
        except httpx.ConnectError as exc:
            elapsed = (time.monotonic() - t0) * 1000
            logger.warning(
                "adk-flair: connect to %s failed (elapsed=%.0fms, phase=connect). "
                "Is Flair running? Check FLAIR_URL.",
                self._url, elapsed,
            )
            raise
        except httpx.ReadError as exc:
            elapsed = (time.monotonic() - t0) * 1000
            logger.warning(
                "adk-flair: read from %s failed (elapsed=%.0fms, phase=read). "
                "Flair may be overloaded or unreachable.",
                self._url, elapsed,
            )
            raise
        except httpx.TimeoutException as exc:
            elapsed = (time.monotonic() - t0) * 1000
            logger.warning(
                "adk-flair: request to %s timed out (elapsed=%.0fms). "
                "Check FLAIR_URL and network connectivity.",
                self._url, elapsed,
            )
            raise

        if resp.status_code >= 400:
            raise RuntimeError(
                f"Flair {method} {path} → {resp.status_code} {resp.reason_phrase}"
            )

        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            return resp.json()
        return resp.text

    # ── BaseMemoryService implementation ─────────────────────────────────────

    async def add_session_to_memory(self, session: Session) -> None:
        """Batch-write session events to Flair. Filters no-text events.

        Re-ingestion is idempotent via deterministic record ids.
        """
        app_name = session.app_name
        user_id = session.user_id
        session_id = session.id
        tag = _compound_tag(app_name, user_id)

        events = session.events or []
        written = 0
        for event in events:
            # Filter no-text events (same heuristic as Vertex impl)
            text = self._extract_event_text(event)
            if not text:
                continue

            record_id = _deterministic_record_id(
                app_name, user_id, session_id, event.id or str(uuid.uuid4())
            )
            body = {
                "id": record_id,
                "agentId": self._agent_id,
                "content": text,
                "type": "session",
                "durability": "standard",
                "tags": [tag],
                "createdAt": _iso_now(),
            }
            try:
                await self._request("PUT", f"/Memory/{record_id}", json_body=body)
                written += 1
            except Exception:
                logger.warning(
                    "adk-flair: write failed for session %s event %s",
                    session_id, event.id,
                )

        if written:
            logger.debug(
                "adk-flair: wrote %d events for session %s (app=%s, user=%s)",
                written, session_id, app_name, user_id,
            )

    async def add_events_to_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        events: Sequence[Any],
        session_id: Optional[str] = None,
        custom_metadata: Optional[Mapping[str, object]] = None,
    ) -> None:
        """Incremental per-turn event writes (the quickstart's after_agent_callback path)."""
        tag = _compound_tag(app_name, user_id)
        sid = session_id or ""

        # custom_metadata warn-once per session
        if custom_metadata:
            session_key = f"{app_name}:{user_id}:{sid}"
            if session_key not in self._warned_sessions:
                self._warned_sessions.add(session_key)
                logger.warning(
                    "adk-flair: custom_metadata ignored — adk-flair does not "
                    "support custom_metadata keys (session=%s)", session_key
                )

        written = 0
        for event in events:
            text = self._extract_event_text(event)
            if not text:
                continue

            event_id = getattr(event, "id", "") or str(uuid.uuid4())
            record_id = _deterministic_record_id(app_name, user_id, sid, event_id)
            body = {
                "id": record_id,
                "agentId": self._agent_id,
                "content": text,
                "type": "session",
                "durability": "standard",
                "tags": [tag],
                "createdAt": _iso_now(),
            }
            try:
                await self._request("PUT", f"/Memory/{record_id}", json_body=body)
                written += 1
            except Exception:
                logger.warning(
                    "adk-flair: write failed for session %s event %s",
                    sid, event_id,
                )

        if written:
            logger.debug(
                "adk-flair: wrote %d events (app=%s, user=%s, session=%s)",
                written, app_name, user_id, sid,
            )

    async def add_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        memories: Sequence[MemoryEntry],
        custom_metadata: Optional[Mapping[str, object]] = None,
    ) -> None:
        """Direct memory writes — each MemoryEntry becomes a Flair record."""
        tag = _compound_tag(app_name, user_id)

        # custom_metadata warn-once
        if custom_metadata:
            session_key = f"{app_name}:{user_id}:direct"
            if session_key not in self._warned_sessions:
                self._warned_sessions.add(session_key)
                logger.warning(
                    "adk-flair: custom_metadata ignored — adk-flair does not "
                    "support custom_metadata keys"
                )

        written = 0
        for mem in memories:
            content_text = self._extract_content_text(mem.content)
            if not content_text:
                continue

            record_id = mem.id or hashlib.sha256(content_text.encode()).hexdigest()[:32]
            body: Dict[str, Any] = {
                "id": record_id,
                "agentId": self._agent_id,
                "content": content_text,
                "type": "session",
                "durability": "standard",
                "tags": [tag],
                "createdAt": mem.timestamp or _iso_now(),
            }
            if mem.author:
                body["author"] = mem.author
            try:
                await self._request("PUT", f"/Memory/{record_id}", json_body=body)
                written += 1
            except Exception:
                logger.warning(
                    "adk-flair: direct memory write failed for id %s", record_id,
                )

        if written:
            logger.debug(
                "adk-flair: wrote %d direct memories (app=%s, user=%s)",
                written, app_name, user_id,
            )

    async def search_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        query: str,
    ) -> SearchMemoryResponse:
        """Semantic search over Flair memories scoped to this app+user.

        user_id is mandatory — missing/empty returns empty, never searches unscoped.
        """
        # Mandatory user_id gate
        if not user_id:
            return SearchMemoryResponse(memories=[])

        tag = _compound_tag(app_name, user_id)

        try:
            body = {
                "agentId": self._agent_id,
                "q": query,
                "limit": 20,
                "tag": tag,
            }
            result = await self._request("POST", "/SemanticSearch", json_body=body)
        except Exception:
            logger.warning(
                "adk-flair: search failed for app=%s user=%s — returning empty. "
                "Check FLAIR_URL and that Flair is running.",
                app_name, user_id,
            )
            return SearchMemoryResponse(memories=[])

        hits = result.get("results", []) if isinstance(result, dict) else []
        if not isinstance(hits, list):
            return SearchMemoryResponse(memories=[])

        memories: List[MemoryEntry] = []
        for hit in hits:
            if not isinstance(hit, dict):
                continue

            # Tag re-verification: every hit must carry the compound tag.
            # This is the client-side analogue of Flair's isAllowed defense-in-depth.
            hit_tags: List[str] = hit.get("tags") or []
            if tag not in hit_tags:
                continue

            content_text = hit.get("content") or ""
            memories.append(
                MemoryEntry(
                    id=hit.get("id"),
                    content=types.Content(
                        role="model",
                        parts=[types.Part(text=content_text)],
                    ),
                    author=hit.get("author"),
                    timestamp=hit.get("createdAt"),
                )
            )

        return SearchMemoryResponse(memories=memories)

    # ── Event text extraction ────────────────────────────────────────────────

    @staticmethod
    def _extract_event_text(event: Any) -> Optional[str]:
        """Extract text content from an ADK Event, mirroring the Vertex impl's
        no-text filtering heuristic."""
        # Try content.parts[].text first
        content = getattr(event, "content", None)
        if content is not None:
            parts = getattr(content, "parts", None) or []
            texts = []
            for p in parts:
                t = getattr(p, "text", None)
                if t:
                    texts.append(str(t))
            if texts:
                return " ".join(texts)

        # Fallback: check for a top-level text attribute
        text = getattr(event, "text", None)
        if text:
            return str(text)

        return None

    @staticmethod
    def _extract_content_text(content: Any) -> Optional[str]:
        """Extract text from a google.genai.types.Content object."""
        if content is None:
            return None
        parts = getattr(content, "parts", None) or []
        texts = []
        for p in parts:
            t = getattr(p, "text", None)
            if t:
                texts.append(str(t))
        return " ".join(texts) if texts else None

    # ── Cleanup ──────────────────────────────────────────────────────────────

    async def close(self) -> None:
        """Close the underlying httpx client."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
