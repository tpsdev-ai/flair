"""Tests for HTTP timeout configuration (flair#1323).

Two tiers, both hermetic (no live_flair fixture — this file runs in the
CI hermetic lane):

1. Resolution unit tests — constructor param / env var / default precedence,
   observable in the created httpx client's timeout config.
2. The acceptance pair from flair#1323 — a deliberately slow (>1.5s) local
   HTTP server: the same request FAILS under the shipped defaults (positive
   control that the default really is the fail-fast path) and SUCCEEDS under
   an overridden timeout.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import httpx
import pytest


_DEFAULTS = {"connect": 0.5, "read": 1.5, "write": 1.0, "pool": 0.5}


def _make_service(env: dict[str, str], **kwargs):
    """Construct a FlairMemoryService with key-loading/signing mocked and an
    exactly-controlled environment (clear=True — no ambient FLAIR_* leaks in)."""
    from adk_flair.memory_service import FlairMemoryService

    base_env = {"FLAIR_AGENT_ID": "test-agent", "FLAIR_KEYFILE": "/fake/keyfile"}
    with patch(
        "adk_flair.memory_service._load_ed25519_key",
        return_value=MagicMock(),
    ), patch.dict("os.environ", {**base_env, **env}, clear=True):
        return FlairMemoryService(url="http://localhost:19926", **kwargs)


def _client_timeout(svc) -> httpx.Timeout:
    """The timeout config of the ACTUALLY CREATED httpx client — the
    acceptance criterion is observability in the client, not in a field."""
    return svc._http.timeout


# ─── Resolution: param / env / default precedence ───────────────────────────


class TestTimeoutResolution:
    def test_default_unchanged_when_nothing_set(self):
        svc = _make_service({})
        t = _client_timeout(svc)
        assert (t.connect, t.read, t.write, t.pool) == (
            _DEFAULTS["connect"], _DEFAULTS["read"], _DEFAULTS["write"], _DEFAULTS["pool"],
        )

    def test_float_param_sets_read_write_and_caps_connect(self):
        svc = _make_service({}, timeout=30.0)
        t = _client_timeout(svc)
        assert t.read == 30.0
        assert t.write == 30.0
        assert t.connect == 5.0  # min(30, 5.0) cap
        assert t.pool == 5.0

    def test_small_float_param_keeps_connect_below_cap(self):
        svc = _make_service({}, timeout=2.0)
        t = _client_timeout(svc)
        assert t.read == 2.0
        assert t.connect == 2.0  # min(2, 5.0)

    def test_httpx_timeout_param_passes_through_verbatim(self):
        explicit = httpx.Timeout(connect=7.0, read=42.0, write=9.0, pool=3.0)
        svc = _make_service({}, timeout=explicit)
        t = _client_timeout(svc)
        assert (t.connect, t.read, t.write, t.pool) == (7.0, 42.0, 9.0, 3.0)

    def test_env_timeout_applied(self):
        svc = _make_service({"FLAIR_HTTP_TIMEOUT": "10"})
        t = _client_timeout(svc)
        assert t.read == 10.0
        assert t.write == 10.0
        assert t.connect == 5.0
        assert t.pool == 5.0

    def test_connect_env_alone_keeps_default_read(self):
        svc = _make_service({"FLAIR_HTTP_CONNECT_TIMEOUT": "8"})
        t = _client_timeout(svc)
        assert t.connect == 8.0
        assert t.pool == 8.0
        assert t.read == _DEFAULTS["read"]
        assert t.write == _DEFAULTS["write"]

    def test_connect_env_overrides_derived_connect(self):
        svc = _make_service({"FLAIR_HTTP_CONNECT_TIMEOUT": "9"}, timeout=30.0)
        t = _client_timeout(svc)
        assert t.read == 30.0
        assert t.connect == 9.0  # explicit connect env beats the min(read, 5) rule

    def test_float_param_beats_env(self):
        svc = _make_service({"FLAIR_HTTP_TIMEOUT": "3"}, timeout=20.0)
        t = _client_timeout(svc)
        assert t.read == 20.0

    def test_httpx_timeout_param_ignores_env(self):
        explicit = httpx.Timeout(connect=1.0, read=2.0, write=3.0, pool=4.0)
        svc = _make_service(
            {"FLAIR_HTTP_TIMEOUT": "99", "FLAIR_HTTP_CONNECT_TIMEOUT": "88"},
            timeout=explicit,
        )
        t = _client_timeout(svc)
        assert (t.connect, t.read, t.write, t.pool) == (1.0, 2.0, 3.0, 4.0)

    def test_garbage_env_raises_in_constructor(self):
        with pytest.raises(ValueError, match="FLAIR_HTTP_TIMEOUT"):
            _make_service({"FLAIR_HTTP_TIMEOUT": "fast"})

    def test_nonpositive_env_raises_in_constructor(self):
        with pytest.raises(ValueError, match="FLAIR_HTTP_CONNECT_TIMEOUT"):
            _make_service({"FLAIR_HTTP_CONNECT_TIMEOUT": "0"})

    def test_nonpositive_param_raises(self):
        with pytest.raises(ValueError, match="timeout"):
            _make_service({}, timeout=0)

    async def test_effective_timeouts_logged_with_first_request_line(self, caplog):
        """The first-request WARNING line carries the effective timeouts, so a
        false-fail is diagnosable from the agent's own output."""
        svc = _make_service({}, timeout=30.0)
        svc._client = MagicMock()
        resp = MagicMock(status_code=200, headers={"content-type": "application/json"})
        resp.json.return_value = {}

        async def _fake_request(*a, **k):
            return resp

        svc._client.request = _fake_request
        with patch(
            "adk_flair.memory_service._sign_request",
            return_value="TPS-Ed25519 test-agent:0:0:AAAA",
        ), caplog.at_level("WARNING", logger="adk_flair"):
            await svc._request("POST", "/SemanticSearch", json_body={})

        lines = [r.getMessage() for r in caplog.records if "using Flair at" in r.getMessage()]
        assert len(lines) == 1
        assert "read=30.0s" in lines[0]
        assert "connect=5.0s" in lines[0]


# ─── Acceptance pair: slow server vs fail-fast default (flair#1323) ─────────


class _SlowSearchHandler(BaseHTTPRequestHandler):
    """Responds to POST /SemanticSearch after a delay > the 1.5s default read
    timeout — the hosted-Flair shape (server-side embed + hybrid retrieval)."""

    delay_seconds = 2.0

    def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        time.sleep(self.delay_seconds)
        body = json.dumps({"results": []}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence per-request stderr noise
        pass


@pytest.fixture
def slow_flair_url():
    """A local HTTP server that answers searches slower than the default read
    timeout. Hermetic — a socket on 127.0.0.1, no Harper involved."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SlowSearchHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _make_slow_server_service(url: str, **kwargs):
    from adk_flair.memory_service import FlairMemoryService

    with patch(
        "adk_flair.memory_service._load_ed25519_key",
        return_value=MagicMock(),
    ), patch.dict("os.environ", {
        "FLAIR_AGENT_ID": "test-agent",
        "FLAIR_KEYFILE": "/fake/keyfile",
    }, clear=True):
        svc = FlairMemoryService(url=url, agent_id="test-agent",
                                 keyfile="/fake/keyfile", **kwargs)
    svc._url_logged = True  # suppress first-request log noise
    return svc


class TestSlowServerAcceptancePair:
    """The issue's acceptance pair. Both halves hit the SAME slow server with
    the SAME request — only the timeout config differs."""

    async def test_slow_search_fails_under_defaults(self, slow_flair_url):
        """Positive control: the shipped defaults really are fail-fast — a
        2s response dies on the 1.5s read timeout."""
        svc = _make_slow_server_service(slow_flair_url)
        try:
            with patch(
                "adk_flair.memory_service._sign_request",
                return_value="TPS-Ed25519 test-agent:0:0:AAAA",
            ):
                with pytest.raises(httpx.ReadTimeout):
                    await svc._request(
                        "POST", "/SemanticSearch",
                        json_body={"agentId": "test-agent", "q": "q", "limit": 1},
                    )
        finally:
            await svc.close()

    async def test_slow_search_succeeds_under_override(self, slow_flair_url):
        """The same 2s response succeeds once the timeout is overridden."""
        svc = _make_slow_server_service(slow_flair_url, timeout=10.0)
        try:
            with patch(
                "adk_flair.memory_service._sign_request",
                return_value="TPS-Ed25519 test-agent:0:0:AAAA",
            ):
                result = await svc._request(
                    "POST", "/SemanticSearch",
                    json_body={"agentId": "test-agent", "q": "q", "limit": 1},
                )
            assert result == {"results": []}
        finally:
            await svc.close()

    async def test_slow_search_user_visible_symptom_and_fix(self, slow_flair_url, caplog):
        """End-to-end through search_memory: defaults -> silently empty with
        the 'search failed' warning (the field-reported symptom); override ->
        the search completes WITHOUT that warning. Both branches return [] (the
        server has zero hits), so the warning is the distinguishing signal."""
        from google.adk.memory.base_memory_service import SearchMemoryResponse

        with patch(
            "adk_flair.memory_service._sign_request",
            return_value="TPS-Ed25519 test-agent:0:0:AAAA",
        ):
            svc_default = _make_slow_server_service(slow_flair_url)
            try:
                with caplog.at_level("WARNING", logger="adk_flair"):
                    resp = await svc_default.search_memory(
                        app_name="app", user_id="user", query="q"
                    )
                assert isinstance(resp, SearchMemoryResponse)
                assert resp.memories == []  # swallowed timeout -> empty recall
                assert any(
                    "search failed" in r.getMessage() for r in caplog.records
                ), "defaults against a slow server must hit the swallowed-timeout path"
            finally:
                await svc_default.close()

            caplog.clear()
            svc_override = _make_slow_server_service(slow_flair_url, timeout=10.0)
            try:
                with caplog.at_level("WARNING", logger="adk_flair"):
                    resp = await svc_override.search_memory(
                        app_name="app", user_id="user", query="q"
                    )
                assert isinstance(resp, SearchMemoryResponse)
                assert resp.memories == []  # zero hits — but the search COMPLETED:
                assert not any(
                    "search failed" in r.getMessage() for r in caplog.records
                ), "override must not fall into the swallowed-timeout path"
            finally:
                await svc_override.close()
