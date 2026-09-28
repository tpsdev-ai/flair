"""flair#1987 — the ADK Python memory service signs the path it sends when the
base URL has a path.

`FlairMemoryService._request` used to sign the bare route before handing it to
`httpx.AsyncClient(base_url=...)`. With a base URL that has a path (for example
a deployment served at ``https://host/flair``), httpx sent
``/flair/Memory/<id>`` while the signature covered ``/Memory/<id>``, so the
server refused the request.

These tests drive the REAL request path through an ``httpx.MockTransport`` and
verify the Ed25519 signature over exactly the raw path the request carried.
"""

from __future__ import annotations

import base64

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from adk_flair import memory_service as ms


def _keypair():
    priv = ed25519.Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return priv, pub


def _make_service(monkeypatch, base: str, priv) -> "ms.FlairMemoryService":
    monkeypatch.setenv("FLAIR_ALLOW_REMOTE_URL", "1")
    monkeypatch.setattr(ms, "_load_ed25519_key", lambda _path: priv)
    svc = ms.FlairMemoryService(url=base, agent_id="path-agent", keyfile="/unused.key")
    svc._url_logged = True  # suppress the first-request log line
    return svc


def _attach_transport(svc, captured: list) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"ok": True}, headers={"content-type": "application/json"})

    svc._client = httpx.AsyncClient(base_url=svc._url, transport=httpx.MockTransport(handler))


def _assert_signature_covers(request: httpx.Request, public_raw: bytes, sent_path: str, method: str) -> None:
    """Verify the TPS-Ed25519 signature over `sent_path`; raises on failure."""
    auth = request.headers.get("authorization", "")
    assert auth.startswith("TPS-Ed25519 "), auth
    agent, ts, nonce, sig_b64 = auth[len("TPS-Ed25519 "):].split(":")
    payload = f"{agent}:{ts}:{nonce}:{method}:{sent_path}".encode("utf-8")
    pub = ed25519.Ed25519PublicKey.from_public_bytes(public_raw)
    pub.verify(base64.b64decode(sig_b64), payload)


@pytest.mark.parametrize(
    "base, expected",
    [
        ("http://h", "/Memory/abc"),  # no base path, no slash
        ("http://h/", "/Memory/abc"),  # no base path, trailing slash
        ("http://h/flair", "/flair/Memory/abc"),  # base path, no slash
        ("http://h/flair/", "/flair/Memory/abc"),  # base path, trailing slash
    ],
)
async def test_base_path_is_preserved_and_signed_as_sent(monkeypatch, base, expected):
    priv, pub = _keypair()
    svc = _make_service(monkeypatch, base, priv)
    captured: list = []
    _attach_transport(svc, captured)
    try:
        await svc._request("GET", "/Memory/abc")
    finally:
        await svc._client.aclose()

    assert len(captured) == 1
    req = captured[0]
    received_path = req.url.raw_path.decode("ascii")  # derived from the URL, not slicing
    assert received_path == expected  # assertion: base path preserved, exactly one slash
    _assert_signature_covers(req, pub, received_path, "GET")  # assertion: signed path == sent path


@pytest.mark.parametrize(
    "base",
    ["http://h/?tenant=1", "http://h/#frag", "http://h/?", "http://h/#", "http://h/flair?", "http://h/flair#"],
)
async def test_base_with_query_or_fragment_is_refused_before_any_request(monkeypatch, base):
    priv, _ = _keypair()
    svc = _make_service(monkeypatch, base, priv)
    captured: list = []
    _attach_transport(svc, captured)
    try:
        with pytest.raises(ValueError, match="query string or fragment"):
            await svc._request("GET", "/Memory/abc")
    finally:
        await svc._client.aclose()

    assert captured == []  # assertion: no request was sent


@pytest.mark.parametrize(
    "base, signed_path",
    [
        ("http://h", "/SemanticSearch?x=1"),
        ("http://h/flair", "/flair/SemanticSearch?x=1"),
    ],
)
async def test_route_with_its_own_query_signs_pathname_plus_search(monkeypatch, base, signed_path):
    priv, pub = _keypair()
    svc = _make_service(monkeypatch, base, priv)
    captured: list = []
    _attach_transport(svc, captured)
    try:
        await svc._request("POST", "/SemanticSearch?x=1", json_body={"q": "hello"})
    finally:
        await svc._client.aclose()

    assert len(captured) == 1
    req = captured[0]
    assert req.url.path == signed_path.split("?")[0]  # assertion: pathname only
    assert req.url.query.decode("ascii") == "x=1"  # assertion: the route's own query survives
    received_path = req.url.raw_path.decode("ascii")
    assert received_path == signed_path
    _assert_signature_covers(req, pub, received_path, "POST")  # assertion: signed pathname+search


# "?" and "#" inside a record id: percent-encoding keeps the id as ONE path
# segment instead of splitting it into a query/fragment.
_RESERVED_ID = "a/b%c d?e#f"


@pytest.mark.parametrize(
    "abs_url",
    ["http://h/Memory/abc", "https://h/flair/Memory/abc", "//h/Memory/abc"],
)
async def test_absolute_url_as_route_is_refused_before_any_request(monkeypatch, abs_url):
    priv, _ = _keypair()
    svc = _make_service(monkeypatch, "http://h/flair", priv)
    captured: list = []
    _attach_transport(svc, captured)
    try:
        with pytest.raises(ValueError, match="absolute"):  # assertion: an absolute route is refused
            await svc._request("GET", abs_url)
    finally:
        await svc._client.aclose()

    assert captured == []  # assertion: no request was sent


async def test_reserved_id_is_exactly_one_encoded_segment_signed_as_sent(monkeypatch):
    """An id containing "/", "%", a space, "?" and "#" reaches the server as
    exactly ONE percent-encoded path segment, and the signature covers exactly
    the captured path."""
    priv, pub = _keypair()
    svc = _make_service(monkeypatch, "http://h/flair", priv)
    captured: list = []
    _attach_transport(svc, captured)
    encoded = ms._encode_record_id(_RESERVED_ID)
    try:
        await svc._request("PUT", f"/Memory/{encoded}")
    finally:
        await svc._client.aclose()

    assert len(captured) == 1
    req = captured[0]
    received_path = req.url.raw_path.decode("ascii")
    segments = [seg for seg in received_path.split("/") if seg]
    assert segments == ["flair", "Memory", encoded]  # assertion: exactly ONE encoded id segment
    _assert_signature_covers(req, pub, received_path, "PUT")  # assertion: signed path == captured path
