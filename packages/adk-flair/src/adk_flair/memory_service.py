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
import json
import logging
import math
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union
from urllib.parse import quote, urlparse

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

# HTTP timeout configuration (flair#1323).
#
# The defaults are deliberate LOCALHOST FAIL-FAST tuning, not an accident:
# ADK's search path swallows exceptions, so a down local Flair must fail
# instantly rather than hang the agent on every recall. Against a hosted
# Flair over TLS + WAN these numbers false-fail (connect=0.5s barely covers
# a cold TLS handshake; read=1.5s is under a legitimate server-side
# embed + hybrid retrieval) — hosted deployments override via the
# constructor `timeout` param or the env vars below.
_TIMEOUT_ENV = "FLAIR_HTTP_TIMEOUT"          # read/write timeout, seconds (float)
_CONNECT_TIMEOUT_ENV = "FLAIR_HTTP_CONNECT_TIMEOUT"  # connect/pool timeout, seconds (float)
_DEFAULT_CONNECT_TIMEOUT = 0.5
_DEFAULT_READ_TIMEOUT = 1.5
_DEFAULT_WRITE_TIMEOUT = 1.0
_DEFAULT_POOL_TIMEOUT = 0.5
# When only a read timeout is given, connect is derived as
# min(read, _CONNECT_TIMEOUT_CAP): connection setup should never need more
# than a few seconds even over WAN, while read scales with server-side work.
_CONNECT_TIMEOUT_CAP = 5.0

# Valid enum values for the explicit write knobs (flair#1238 — moved to module
# level from inside add_memory; Sherlock's cosmetic note on #1237).
_VALID_DURABILITIES = frozenset(["permanent", "persistent", "standard", "ephemeral"])
_VALID_VISIBILITIES = frozenset(["private", "shared"])

# custom_metadata caps (flair#1332, Sherlock hard requirements). REJECT, never
# truncate — a truncated blob silently corrupts the store-and-return round-trip
# guarantee, which is the entire contract of the field.
#   - _METADATA_MAX_BYTES: serialized JSON size cap. 64KB is generous for
#     structured attributes (merchant/price/category/media refs) while keeping
#     a single memory record from becoming a blob store.
#   - _METADATA_MAX_DEPTH / _METADATA_MAX_KEYS: cheap structural caps checked
#     BEFORE serialization (billion-laughs-adjacent guard — a pathologically
#     nested/wide dict is refused without ever attempting to serialize it).
_METADATA_MAX_BYTES = 64 * 1024
_METADATA_MAX_DEPTH = 16
_METADATA_MAX_KEYS = 512

# subject cap (flair#1332): subject is a short human-readable title promoted to
# the record's top-level indexed `subject` column — never a content field.
_SUBJECT_MAX_CHARS = 512

# list_memories page-size hard cap (flair#1333). Reject-with-error (never
# clamp) — consistent with every other adk-flair validation: a silently
# clamped limit would make "I asked for 500, why did I get 200" a debugging
# session instead of an immediate, actionable ValueError.
_LIST_MEMORIES_MAX_LIMIT = 200

# ─── Errors ─────────────────────────────────────────────────────────────────


class FlairRequestError(RuntimeError):
    """An HTTP-level failure from Flair, carrying the status code.

    Subclasses RuntimeError with an identical message to the bare
    RuntimeError this replaced, so existing ``except RuntimeError`` /
    ``str(exc)`` handling is unchanged. What it adds: ``status_code``
    (plus ``method``/``path``/``reason``) as attributes — the write-path
    warning logs probe ``exc.status_code`` and, before this class existed,
    always fell through to ``status=?`` (the undiagnosable log line in
    flair#1336's field report). It also lets callers branch on specific
    statuses (the 409 create-fallback in ``_write_memory_record``).
    """

    def __init__(self, method: str, path: str, status_code: int, reason: str):
        super().__init__(f"Flair {method} {path} → {status_code} {reason}")
        self.method = method
        self.path = path
        self.status_code = status_code
        self.reason = reason


# ─── Helpers ────────────────────────────────────────────────────────────────


def _sanitize_tag_segment(value: str) -> str:
    """Percent-encode the reserved characters in a tag segment so distinct
    inputs never collide and the compound-tag delimiter ':' stays unambiguous.

    The old scheme replaced ':' -> '_', which COLLIDED: ``user_id="alice:admin"``
    and ``user_id="alice_admin"`` both sanitized to ``alice_admin`` — one
    tag for two distinct identities. Once the compound tag is the per-user
    access-control boundary (ADK session distillation, #1205), that collision
    is a cross-user contamination bug.

    This encoding is reversible and collision-free. ``%`` is escaped FIRST so
    it can introduce escapes, then ``:`` (the delimiter) and ``_`` (the old
    escape char). Because every escape starts with an already-escaped ``%``,
    no input can forge another input's encoding — see _desanitize_tag_segment
    for the exact inverse.
    """
    return (
        value.replace("%", "%25")
        .replace(":", "%3A")
        .replace("_", "%5F")
    )


def _desanitize_tag_segment(value: str) -> str:
    """Inverse of _sanitize_tag_segment. ``%25`` is decoded LAST so a literal
    ``%3A`` in the original input (which encoded to ``%253A``) is not mistaken
    for an encoded ':'. Round-trips exactly: desanitize(sanitize(x)) == x."""
    return (
        value.replace("%3A", ":")
        .replace("%5F", "_")
        .replace("%25", "%")
    )


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
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _parse_ed25519_key(raw: bytes) -> ed25519.Ed25519PrivateKey:
    """Parse Ed25519 key bytes in any encoding Flair produces or consumes.

    Mirrors src/lib/auth-resolve.ts:buildEd25519Auth so the adapter reads
    exactly the keyfiles Flair itself writes and signs with:

      - raw 32-byte Ed25519 seed (binary) — what ``flair agent add`` writes
      - base64-encoded raw 32-byte seed
      - base64-encoded PKCS8 DER (the historical adk-flair format)
      - PEM (``-----BEGIN PRIVATE KEY-----``)
    """
    # 1) Raw 32-byte seed on disk (binary) — `flair agent add` format.
    if len(raw) == 32:
        return ed25519.Ed25519PrivateKey.from_private_bytes(raw)

    text = raw.decode("utf-8").strip()  # raises UnicodeDecodeError on binary junk

    # 2) PEM.
    if "-----BEGIN" in text:
        key = serialization.load_pem_private_key(text.encode("ascii"), password=None)
        if not isinstance(key, ed25519.Ed25519PrivateKey):
            raise ValueError(f"not an Ed25519 key (got {type(key).__name__})")
        return key

    # 3/4) base64 — either a raw 32-byte seed or a full PKCS8 DER.
    decoded = base64.b64decode(text)
    if len(decoded) == 32:
        return ed25519.Ed25519PrivateKey.from_private_bytes(decoded)
    key = serialization.load_der_private_key(decoded, password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise ValueError(f"not an Ed25519 key (got {type(key).__name__})")
    return key


def _load_ed25519_key(keyfile: str) -> ed25519.Ed25519PrivateKey:
    """Load and validate an Ed25519 private key from a Flair keyfile.

    Accepts every on-disk encoding Flair produces (see ``_parse_ed25519_key``),
    so the keyfile written by ``flair agent add`` (a raw 32-byte seed) loads
    without a conversion step. A leading ``~`` in the path is expanded.

    Raises ValueError naming FLAIR_KEYFILE on any failure — the failure lands
    in the constructor, never deferred to first use (where ADK's
    exception-swallowing search path would turn it into silent empty recall).
    """
    path = Path(keyfile).expanduser()
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raise ValueError(
            "FLAIR_KEYFILE points to a file that does not exist. Provision one "
            "with `flair agent add <agent-id>` (writes ~/.flair/keys/<agent-id>.key), "
            "then set FLAIR_KEYFILE to it."
        ) from None

    if not raw.strip():
        raise ValueError("FLAIR_KEYFILE points to an empty file")

    try:
        return _parse_ed25519_key(raw)
    except ValueError as exc:
        if "FLAIR_KEYFILE" in str(exc):
            raise
        raise ValueError(
            "FLAIR_KEYFILE does not contain a valid Ed25519 key (accepted: raw "
            "32-byte seed, base64 seed, base64 PKCS8 DER, or PEM)"
        ) from exc
    except Exception as exc:  # UnicodeDecodeError, binascii.Error, InvalidKey, …
        raise ValueError(
            "FLAIR_KEYFILE does not contain a valid Ed25519 key (accepted: raw "
            "32-byte seed, base64 seed, base64 PKCS8 DER, or PEM)"
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


def _positive_seconds_from_env(env_var: str) -> Optional[float]:
    """Parse an env var as positive float seconds; None when unset/empty.

    Raises ValueError naming the env var on garbage — the failure lands in the
    constructor, never deferred to first use (where ADK's exception-swallowing
    search path would turn a misconfigured timeout into silent empty recall).
    """
    raw = os.environ.get(env_var, "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(
            f"{env_var} must be a number of seconds (got: {raw!r})"
        ) from None
    # Non-finite values slip a bare `<= 0` guard (nan compares False to
    # everything; inf <= 0 is False) and would yield a NO-timeout client —
    # and "inf"/"Infinity"/"nan" all parse successfully via float().
    if not math.isfinite(value) or value <= 0:
        raise ValueError(
            f"{env_var} must be a finite number > 0 seconds (got: {raw!r})"
        )
    return value


def _resolve_timeout(
    timeout: Optional[Union[float, httpx.Timeout]],
) -> httpx.Timeout:
    """Resolve the effective httpx.Timeout for the Flair client (flair#1323).

    Precedence, per knob (highest wins):
      - An ``httpx.Timeout`` constructor param is used VERBATIM — fully
        specified, so both env vars are ignored.
      - read/write:  float constructor param > FLAIR_HTTP_TIMEOUT > defaults
        (read=1.5, write=1.0 — localhost fail-fast, see comment at the
        constants).
      - connect/pool: FLAIR_HTTP_CONNECT_TIMEOUT > min(resolved read, 5.0)
        when read was overridden > default (0.5).

    With neither param nor env set the defaults are returned unchanged.
    """
    if isinstance(timeout, httpx.Timeout):
        return timeout

    if timeout is not None:
        timeout = float(timeout)
        # Same non-finite guard as the env path: nan/inf pass a bare `<= 0`.
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError(
                f"timeout must be a finite number > 0 seconds (got: {timeout!r})"
            )

    read_override = timeout if timeout is not None else _positive_seconds_from_env(_TIMEOUT_ENV)
    connect_override = _positive_seconds_from_env(_CONNECT_TIMEOUT_ENV)

    if read_override is None and connect_override is None:
        return httpx.Timeout(
            connect=_DEFAULT_CONNECT_TIMEOUT,
            read=_DEFAULT_READ_TIMEOUT,
            write=_DEFAULT_WRITE_TIMEOUT,
            pool=_DEFAULT_POOL_TIMEOUT,
        )

    if read_override is not None:
        read = write = read_override
        connect = pool = min(read_override, _CONNECT_TIMEOUT_CAP)
    else:
        read = _DEFAULT_READ_TIMEOUT
        write = _DEFAULT_WRITE_TIMEOUT
        connect = _DEFAULT_CONNECT_TIMEOUT
        pool = _DEFAULT_POOL_TIMEOUT

    if connect_override is not None:
        connect = pool = connect_override

    return httpx.Timeout(connect=connect, read=read, write=write, pool=pool)


# ─── custom_metadata / subject (flair#1332) ─────────────────────────────────


def _validate_metadata_shape(custom_metadata: Mapping[str, object]) -> None:
    """Structural caps on custom_metadata, checked BEFORE serialization.

    Rejects nesting deeper than _METADATA_MAX_DEPTH levels or more than
    _METADATA_MAX_KEYS total dict keys (counted across every level) with a
    ValueError. Iterative traversal — no recursion, so adversarial nesting
    can't blow the Python stack; a self-referencing structure terminates via
    the depth cap (each revisit is pushed one level deeper).
    """
    stack: List[tuple] = [(custom_metadata, 1)]
    key_count = 0
    while stack:
        node, depth = stack.pop()
        if depth > _METADATA_MAX_DEPTH:
            raise ValueError(
                f"custom_metadata nesting exceeds {_METADATA_MAX_DEPTH} levels — "
                "flatten the structure, or store a reference to the data instead "
                "of embedding it"
            )
        if isinstance(node, Mapping):
            key_count += len(node)
            if key_count > _METADATA_MAX_KEYS:
                raise ValueError(
                    f"custom_metadata carries more than {_METADATA_MAX_KEYS} keys "
                    "in total — split the data across memories, or store a "
                    "reference to it instead"
                )
            children = node.values()
        elif isinstance(node, (list, tuple)):
            children = node
        else:
            continue
        for child in children:
            if isinstance(child, (Mapping, list, tuple)):
                stack.append((child, depth + 1))


def _serialize_custom_metadata(
    custom_metadata: Optional[Mapping[str, object]],
    context_key: str,
) -> Optional[str]:
    """Serialize custom_metadata to the JSON string stored in Memory.metadata.

    Store-and-return contract (#1202): the blob is opaque to the server —
    stored verbatim, returned verbatim, no key in it influences any server
    decision.

    - Structural caps (depth/key-count) and the serialized 64KB cap REJECT
      with ValueError — never truncate (truncation corrupts the round-trip
      guarantee; Sherlock hard requirement).
    - A non-serializable VALUE skips that key with a WARNING naming the
      session key — one bad value must not discard the caller's whole blob.

    Returns None when there is nothing to store (no metadata, or every key
    was skipped).
    """
    if not custom_metadata:
        return None

    _validate_metadata_shape(custom_metadata)

    clean: Dict[str, Any] = {}
    for key, value in custom_metadata.items():
        if not isinstance(key, str):
            logger.warning(
                "adk-flair: custom_metadata key %r skipped — keys must be "
                "strings (session=%s)", key, context_key,
            )
            continue
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            logger.warning(
                "adk-flair: custom_metadata key %r skipped — value is not "
                "JSON-serializable (session=%s)", key, context_key,
            )
            continue
        clean[key] = value

    if not clean:
        return None

    serialized = json.dumps(clean)
    size = len(serialized.encode("utf-8"))
    if size > _METADATA_MAX_BYTES:
        raise ValueError(
            f"custom_metadata serializes to {size} bytes, over the "
            f"{_METADATA_MAX_BYTES}-byte cap — store large payloads elsewhere "
            "and keep a reference here. Rejected rather than truncated: a "
            "truncated blob would silently corrupt the store-and-return "
            "round-trip guarantee."
        )
    return serialized


def _resolve_subject(
    explicit_subject: Optional[str],
    custom_metadata: Optional[Mapping[str, object]],
) -> Optional[str]:
    """Resolve the top-level `subject` column value (flair#1332).

    Precedence: an explicit subject param is authoritative over
    custom_metadata["subject"] when both are supplied. NEVER auto-extracted
    from content. Rejects non-string or over-cap (512 chars) values with a
    ValueError — subject is a short human-readable title promoted to an
    indexed column, not a content field. Returns None when neither source
    supplies one (empty strings resolve to None — nothing to promote).
    """
    subject: Any = explicit_subject
    source = "subject param"
    if subject is None and custom_metadata is not None:
        try:
            subject = custom_metadata.get("subject")
        except AttributeError:
            subject = None
        source = 'custom_metadata["subject"]'
    if subject is None:
        return None
    if not isinstance(subject, str):
        raise ValueError(
            f"{source} must be a string (got: {type(subject).__name__}) — "
            "subject is promoted to the record's top-level subject column"
        )
    if len(subject) > _SUBJECT_MAX_CHARS:
        raise ValueError(
            f"{source} is {len(subject)} characters, over the "
            f"{_SUBJECT_MAX_CHARS}-char cap — subject is a short "
            "human-readable title; put longer text in content or "
            "custom_metadata"
        )
    return subject or None


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
        timeout: HTTP timeout. A float sets the read/write timeout in seconds
            (connect derived as min(timeout, 5.0)); an httpx.Timeout is used
            verbatim. Default: FLAIR_HTTP_TIMEOUT / FLAIR_HTTP_CONNECT_TIMEOUT
            env vars, else localhost fail-fast defaults (read=1.5s) — hosted
            Flair over TLS/WAN needs an override (flair#1323).
    """

    def __init__(
        self,
        url: Optional[str] = None,
        agent_id: Optional[str] = None,
        keyfile: Optional[str] = None,
        timeout: Optional[Union[float, httpx.Timeout]] = None,
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

        # Resolve HTTP timeouts in the constructor (param > env > fail-fast
        # defaults) so a malformed FLAIR_HTTP_TIMEOUT fails here, loudly.
        self._timeout = _resolve_timeout(timeout)

        # httpx client — created lazily on first request
        self._client: Optional[httpx.AsyncClient] = None

        # First-request URL logging gate
        self._url_logged = False

    # ── HTTP plumbing ────────────────────────────────────────────────────────

    @property
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._url,
                timeout=self._timeout,
            )
        return self._client

    async def _request(
        self, method: str, path: str, *, json_body: Optional[dict] = None
    ) -> Any:
        """Make an authenticated request to Flair. One attempt, no retry."""
        if not self._url_logged:
            logger.warning(
                "adk-flair: using Flair at %s (agent=%s, timeouts: connect=%ss "
                "read=%ss write=%ss pool=%ss — override via FLAIR_HTTP_TIMEOUT "
                "if hosted searches time out)",
                self._url, self._agent_id,
                self._timeout.connect, self._timeout.read,
                self._timeout.write, self._timeout.pool,
            )
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
            raise FlairRequestError(
                method, path, resp.status_code, resp.reason_phrase
            )

        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            return resp.json()
        return resp.text

    async def _write_memory_record(
        self, record_id: str, body: Dict[str, Any]
    ) -> None:
        """Create-or-replace one Memory record.

        Creates via ``POST /Memory/`` — Harper's collection create verb —
        with the id in the body. The previous shape, ``PUT /Memory/{id}``,
        is update-only on some Harper deployments and 404s when the record
        does not exist yet (flair#1336, observed on hosted Harper Fabric;
        not reproducible on stock Harper 5.2.x, where PUT upserts).

        A 409 from POST means the record already exists — re-ingestion of a
        deterministic id (add_session_to_memory re-saves a growing session's
        earlier events every time) or a caller-supplied id being rewritten.
        Fall back to ``PUT /Memory/{id}`` for exactly that case, preserving
        the pre-#1336 replace/refresh semantics for existing rows. Any other
        error propagates unchanged.
        """
        try:
            await self._request("POST", "/Memory/", json_body=body)
        except FlairRequestError as exc:
            if exc.status_code != 409:
                raise
            await self._request("PUT", f"/Memory/{record_id}", json_body=body)

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
                await self._write_memory_record(record_id, body)
                written += 1
            except Exception as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None) or getattr(exc, "status_code", None) or "?"
                logger.warning(
                    "adk-flair: write failed for session %s event %s "
                    "(status=%s, written=%d/%d)",
                    session_id, event.id, status, written, len(events),
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
        """Incremental per-turn event writes (the quickstart's after_agent_callback path).

        custom_metadata (flair#1332) is stored on every record this call
        writes, as an opaque JSON blob on the Memory record's `metadata`
        field, and round-trips back on `MemoryEntry.custom_metadata` from
        search_memory / list_memories. Store-and-return only — no key in it
        has any server-side effect. Caps (ValueError before any write):
        64KB serialized, nesting depth <= 16, <= 512 total keys.
        custom_metadata["subject"] (a string) is additionally promoted to the
        record's top-level `subject` column (<= 512 chars).
        """
        tag = _compound_tag(app_name, user_id)
        sid = session_id or ""

        # custom_metadata → opaque JSON blob + optional promoted subject
        # (flair#1332). Validated/serialized ONCE, before any write — a cap
        # violation raises here and zero events are written, never a partial
        # batch with silently-dropped metadata.
        session_key = f"{app_name}:{user_id}:{sid}"
        metadata_json = _serialize_custom_metadata(custom_metadata, session_key)
        subject_value = _resolve_subject(None, custom_metadata)

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
            if metadata_json is not None:
                body["metadata"] = metadata_json
            if subject_value is not None:
                body["subject"] = subject_value
            try:
                await self._write_memory_record(record_id, body)
                written += 1
            except Exception as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None) or getattr(exc, "status_code", None) or "?"
                logger.warning(
                    "adk-flair: write failed for session %s event %s "
                    "(status=%s, written=%d/%d)",
                    sid, event_id, status, written, len(events),
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
        durability: Optional[str] = None,
        visibility: Optional[str] = None,
        subject: Optional[str] = None,
    ) -> None:
        """Direct memory writes — each MemoryEntry becomes a Flair record.

        custom_metadata (flair#1332) is stored on every record this call
        writes, as an opaque JSON blob on the Memory record's `metadata`
        field, and round-trips back on `MemoryEntry.custom_metadata` from
        search_memory / list_memories. Store-and-return only (the ADK
        contract, #1202): no key inside the blob has ANY server-side effect —
        {"visibility": "shared"} in here does not share the memory (use the
        explicit `visibility` param for that). Caps (ValueError before any
        write; reject, never truncate): 64KB serialized, nesting depth <= 16,
        <= 512 total keys. Non-JSON-serializable values skip that key with a
        WARNING.

        subject (flair#1332, Flair-specific extension): short human-readable
        title promoted to the record's top-level indexed `subject` column.
        Sourced from this param or custom_metadata["subject"]; the explicit
        param is authoritative when both are present. <= 512 chars (ValueError
        beyond). Never auto-extracted from content.

        Optional knobs (trust-anchor opt-in, never model-selected):
            durability: one of permanent, persistent, standard, ephemeral.
                Omitted → "standard" in the body (unchanged behaviour).
            visibility: one of private, shared.
                Omitted → no visibility key in the body (server applies its
                durability-keyed default). Supplied → included verbatim.
        """
        tag = _compound_tag(app_name, user_id)

        # ── Validate explicit durability ─────────────────────────────────
        if durability is not None and durability not in _VALID_DURABILITIES:
            raise ValueError(
                f"durability must be one of {sorted(_VALID_DURABILITIES)} "
                f"(got: {durability!r})"
            )

        # ── Validate explicit visibility ─────────────────────────────────
        if visibility is not None and visibility not in _VALID_VISIBILITIES:
            raise ValueError(
                f"visibility must be one of {sorted(_VALID_VISIBILITIES)} "
                f"(got: {visibility!r})"
            )

        # custom_metadata → opaque JSON blob + optional promoted subject
        # (flair#1332). Validated/serialized ONCE, before any write — a cap
        # violation raises here and zero records are written.
        metadata_json = _serialize_custom_metadata(
            custom_metadata, f"{app_name}:{user_id}:direct"
        )
        subject_value = _resolve_subject(subject, custom_metadata)

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
                "durability": durability if durability is not None else "standard",
                "tags": [tag],
                "createdAt": mem.timestamp or _iso_now(),
            }
            if visibility is not None:
                body["visibility"] = visibility
            if metadata_json is not None:
                body["metadata"] = metadata_json
            if subject_value is not None:
                body["subject"] = subject_value
            if mem.author:
                body["author"] = mem.author
            try:
                await self._write_memory_record(record_id, body)
                written += 1
            except Exception as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None) or getattr(exc, "status_code", None) or "?"
                logger.warning(
                    "adk-flair: direct memory write failed for id %s "
                    "(status=%s, written=%d/%d)",
                    record_id, status, written, len(memories),
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

        Each returned MemoryEntry carries (flair#1332):
          - custom_metadata: the stored metadata blob, parsed back to a dict
            (fail-soft {} + WARNING on malformed JSON — a corrupt blob must
            never take recall down). When the record has a top-level subject,
            it is surfaced as custom_metadata["subject"], the top-level column
            being authoritative over any divergent blob key.
          - author: the writing Flair agent id (the record's agentId).
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
                # flair#1332: opt into the `metadata` blob in each hit.
                # /SemanticSearch's default projection deliberately omits it
                # (other consumers must not pay result-size for a blob they
                # never read); this flag widens the projection for THIS
                # request only. `subject` is in the default projection.
                "includeMetadata": True,
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

            memories.append(self._hit_to_memory_entry(hit))

        return SearchMemoryResponse(memories=memories)

    # ── list_memories (flair#1333 — Flair-specific extension) ───────────────

    async def list_memories(
        self,
        *,
        app_name: str,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> List[MemoryEntry]:
        """List recent memories for an app+user, newest first.

        Flair-specific extension — NOT part of ADK's BaseMemoryService (which
        specifies only search_memory). Useful for memory review UIs,
        dashboards, and agent contextual browsing where there is no query to
        search with.

        Scope: the same compound tag (adk:<app>:<user>) search_memory uses,
        AND agentId == this service's agent identity — both pushed down as
        server-side query conditions and re-verified client-side on every
        returned row (defense in depth).

        Pagination: `offset` is POSITIONAL over a point-in-time snapshot
        ordered by createdAt descending — not a live cursor. Memories written
        between two pages shift positions, so a record can appear twice or be
        skipped across page boundaries. For a consistent view, take one page,
        or dedupe by id across pages.

        Args:
            app_name: ADK app name (required).
            user_id: ADK user id (required — never lists unscoped).
            limit: page size, 1..200. Over-cap REJECTS with ValueError
                (never silently clamps).
            offset: number of newest records to skip (>= 0).

        Returns:
            List[MemoryEntry] with the full projection — content, author
            (the writing agent id), timestamp, and custom_metadata (parsed
            blob; top-level subject surfaced as custom_metadata["subject"]).

        Raises:
            ValueError: invalid app_name/user_id/limit/offset.
            httpx.HTTPError / RuntimeError: transport or server failure.
                Unlike search_memory (whose empty-on-error contract is ADK's),
                this method PROPAGATES failures — a browsing UI must be able
                to tell "no memories" from "Flair is down".
        """
        if not app_name:
            raise ValueError("app_name is required")
        if not user_id:
            raise ValueError("user_id is required — list_memories never lists unscoped")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError(f"limit must be a positive integer (got: {limit!r})")
        if limit > _LIST_MEMORIES_MAX_LIMIT:
            raise ValueError(
                f"limit {limit} exceeds the hard cap of {_LIST_MEMORIES_MAX_LIMIT} "
                "— page with offset instead"
            )
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError(f"offset must be a non-negative integer (got: {offset!r})")

        tag = _compound_tag(app_name, user_id)

        # Harper REST collection query (signed like every other request —
        # the signature covers path+query). The tag value is percent-encoded
        # WHOLESALE: compound tags legitimately contain literal %XX escapes
        # from _sanitize_tag_segment, which must survive the server's URL
        # decode. limit(start,end) is Harper's offset window: start=offset,
        # end=offset+limit.
        path = (
            f"/Memory/?tags={quote(tag, safe='')}"
            f"&agentId={quote(self._agent_id, safe='')}"
            f"&select(id,agentId,content,metadata,subject,tags,createdAt)"
            f"&sort(-createdAt)"
            f"&limit({offset},{offset + limit})"
        )
        rows = await self._request("GET", path)

        if not isinstance(rows, list):
            return []

        entries: List[MemoryEntry] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            # Defense in depth: re-verify both scope conditions client-side,
            # mirroring search_memory's tag re-verification.
            if tag not in (row.get("tags") or []):
                continue
            if row.get("agentId") != self._agent_id:
                continue
            entries.append(self._hit_to_memory_entry(row))
        return entries

    # ── Hit → MemoryEntry mapping ────────────────────────────────────────────

    def _hit_to_memory_entry(self, hit: Dict[str, Any]) -> MemoryEntry:
        """Map a Flair Memory record/hit onto an ADK MemoryEntry.

        author derives from the record's agentId — the writing Flair agent
        (flair#1332 incidental fix: the old code read hit["author"], a field
        Flair neither declares nor projects, so author was always None).
        """
        content_text = hit.get("content") or ""
        return MemoryEntry(
            id=hit.get("id"),
            content=types.Content(
                role="model",
                parts=[types.Part(text=content_text)],
            ),
            author=hit.get("agentId"),
            timestamp=hit.get("createdAt"),
            custom_metadata=self._hit_custom_metadata(hit),
        )

    @staticmethod
    def _hit_custom_metadata(hit: Dict[str, Any]) -> Dict[str, Any]:
        """Rebuild MemoryEntry.custom_metadata from a record's stored fields.

        - `metadata` (the opaque JSON blob) parses back to a dict. FAIL-SOFT:
          malformed JSON (or JSON that isn't an object) yields {} plus a
          WARNING naming the record id — a corrupt blob on one record must
          never take the whole read path down.
        - A top-level `subject` column is surfaced as
          custom_metadata["subject"]. The COLUMN is authoritative (#1332
          ruling): when the blob carries a divergent "subject" key, the
          column value overwrites it in the returned dict. This also means a
          subject written via the explicit param (never in the blob) still
          round-trips on read — MemoryEntry has no subject attribute, so
          custom_metadata is its only return channel.
        """
        parsed: Dict[str, Any] = {}
        raw = hit.get("metadata")
        if raw:
            try:
                loaded = json.loads(raw)
            except (TypeError, ValueError):
                logger.warning(
                    "adk-flair: malformed metadata JSON on record %s — "
                    "returning empty custom_metadata for it", hit.get("id"),
                )
            else:
                if isinstance(loaded, dict):
                    parsed = loaded
                else:
                    logger.warning(
                        "adk-flair: metadata on record %s is JSON but not an "
                        "object — returning empty custom_metadata for it",
                        hit.get("id"),
                    )
        subject = hit.get("subject")
        if isinstance(subject, str) and subject:
            parsed["subject"] = subject
        return parsed

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
