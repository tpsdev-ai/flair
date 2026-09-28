"""flair#1987 — the Hermes plugin signs the path it sends when the base URL has
a path.

`FlairMemoryProvider._request` used to sign the bare route before handing it to
`httpx.Client(base_url=...)`. With a base URL that has a path (for example a
deployment served at ``https://host/flair``), httpx sent
``/flair/Memory/<id>`` while the signature covered ``/Memory/<id>``, so the
server refused the request.

These tests drive the REAL request path through an ``httpx.MockTransport`` and
verify the Ed25519 signature over exactly the raw path the request carried.

Run: ``python -m pytest packages/hermes-flair/test_signed_path_base_url.py -v``
"""

from __future__ import annotations

import base64
import importlib.util as _ilu
import json
import sys
import tempfile
import types
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519


# ─── Stub Hermes-side modules so the plugin imports cleanly ────────────────

def _install_hermes_stubs() -> None:
    if "agent.memory_provider" not in sys.modules:
        agent_mod = types.ModuleType("agent")
        memprov_mod = types.ModuleType("agent.memory_provider")

        class MemoryProvider:
            pass

        memprov_mod.MemoryProvider = MemoryProvider
        agent_mod.memory_provider = memprov_mod
        sys.modules["agent"] = agent_mod
        sys.modules["agent.memory_provider"] = memprov_mod

    if "tools.registry" not in sys.modules:
        tools_mod = types.ModuleType("tools")
        reg_mod = types.ModuleType("tools.registry")
        reg_mod.tool_error = lambda msg: json.dumps({"error": msg})
        tools_mod.registry = reg_mod
        sys.modules["tools"] = tools_mod
        sys.modules["tools.registry"] = reg_mod

    if "hermes_constants" not in sys.modules:
        hc_mod = types.ModuleType("hermes_constants")
        hc_mod.get_hermes_home = lambda: Path(tempfile.gettempdir()) / "hermes-test-home"
        sys.modules["hermes_constants"] = hc_mod


_install_hermes_stubs()

sys.path.insert(0, str(Path(__file__).parent))
_spec = _ilu.spec_from_file_location("flair_plugin_signed_path", str(Path(__file__).parent / "__init__.py"))
flair_plugin = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(flair_plugin)


# ─── Helpers ──────────────────────────────────────────────────────────────

def _keypair():
    priv = ed25519.Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return priv, pub


def _make_provider(base: str, priv, captured: list):
    provider = flair_plugin.FlairMemoryProvider()
    provider._agent_id = "path-agent"
    provider._priv_key = priv
    provider._url = base

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"ok": True}, headers={"content-type": "application/json"})

    provider._client = httpx.Client(base_url=base, transport=httpx.MockTransport(handler))
    return provider


def _assert_signature_covers(request: httpx.Request, public_raw: bytes, sent_path: str, method: str) -> None:
    auth = request.headers.get("authorization", "")
    assert auth.startswith("TPS-Ed25519 "), auth
    agent, ts, nonce, sig_b64 = auth[len("TPS-Ed25519 "):].split(":")
    payload = f"{agent}:{ts}:{nonce}:{method}:{sent_path}".encode("utf-8")
    pub = ed25519.Ed25519PublicKey.from_public_bytes(public_raw)
    pub.verify(base64.b64decode(sig_b64), payload)


# ─── Tests ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "base, expected",
    [
        ("http://h", "/Memory/abc"),  # no base path, no slash
        ("http://h/", "/Memory/abc"),  # no base path, trailing slash
        ("http://h/flair", "/flair/Memory/abc"),  # base path, no slash
        ("http://h/flair/", "/flair/Memory/abc"),  # base path, trailing slash
    ],
)
def test_base_path_is_preserved_and_signed_as_sent(base, expected):
    priv, pub = _keypair()
    captured: list = []
    provider = _make_provider(base, priv, captured)
    try:
        provider._request("GET", "/Memory/abc")
    finally:
        provider._client.close()

    assert len(captured) == 1
    req = captured[0]
    received_path = req.url.raw_path.decode("ascii")  # derived from the URL, not slicing
    assert received_path == expected  # assertion: base path preserved, exactly one slash
    _assert_signature_covers(req, pub, received_path, "GET")  # assertion: signed path == sent path


@pytest.mark.parametrize(
    "base",
    ["http://h/?tenant=1", "http://h/#frag", "http://h/?", "http://h/#", "http://h/flair?", "http://h/flair#"],
)
def test_base_with_query_or_fragment_is_refused_before_any_request(base):
    priv, _ = _keypair()
    captured: list = []
    provider = _make_provider(base, priv, captured)
    try:
        with pytest.raises(ValueError, match="query string or fragment"):
            provider._request("GET", "/Memory/abc")
    finally:
        provider._client.close()

    assert captured == []  # assertion: no request was sent


@pytest.mark.parametrize(
    "base, signed_path",
    [
        ("http://h", "/SemanticSearch?x=1"),
        ("http://h/flair", "/flair/SemanticSearch?x=1"),
    ],
)
def test_route_with_its_own_query_signs_pathname_plus_search(base, signed_path):
    priv, pub = _keypair()
    captured: list = []
    provider = _make_provider(base, priv, captured)
    try:
        provider._request("POST", "/SemanticSearch?x=1", json_body={"q": "hello"})
    finally:
        provider._client.close()

    assert len(captured) == 1
    req = captured[0]
    assert req.url.path == signed_path.split("?")[0]  # assertion: pathname only
    assert req.url.query.decode("ascii") == "x=1"  # assertion: the route's own query survives
    received_path = req.url.raw_path.decode("ascii")
    assert received_path == signed_path
    _assert_signature_covers(req, pub, received_path, "POST")  # assertion: signed pathname+search
