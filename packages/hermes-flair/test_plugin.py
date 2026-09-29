"""Unit tests for the Hermes-Flair memory plugin.

Tests run without Hermes installed by stubbing the two Hermes-side imports
(`agent.memory_provider` and `tools.registry`). Real-Hermes integration is
covered by the plugin's appearance in upstream Hermes CI once landed.

Run: `python -m pytest packages/hermes-flair/test_plugin.py -v`
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import tempfile
import time
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ─── Stub Hermes-side modules so the plugin imports cleanly ────────────────

def _install_hermes_stubs() -> None:
    """Inject minimal stand-ins for `agent.memory_provider` and `tools.registry`."""
    if "agent.memory_provider" not in sys.modules:
        agent_mod = types.ModuleType("agent")
        memprov_mod = types.ModuleType("agent.memory_provider")

        class MemoryProvider:  # minimal ABC stand-in
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

# Now safe to import the plugin under test
sys.path.insert(0, str(Path(__file__).parent))
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("flair_plugin", str(Path(__file__).parent / "__init__.py"))
flair_plugin = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(flair_plugin)


# ─── Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture
def ed25519_key_file(tmp_path):
    """Generate a real Ed25519 key, write as PKCS8 base64, return the path."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    priv = ed25519.Ed25519PrivateKey.generate()
    der = priv.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_b64 = base64.b64encode(der).decode("ascii")
    path = tmp_path / "test-agent.key"
    path.write_text(key_b64, encoding="utf-8")
    return path


@pytest.fixture
def configured_provider(ed25519_key_file, monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "test-agent")
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    monkeypatch.setenv("FLAIR_URL", "http://test.invalid")
    p = flair_plugin.FlairMemoryProvider()
    # Skip _fetch_bootstrap network call by patching _request
    with patch.object(p, "_request", return_value=[]):
        p.initialize(session_id="test-session")
    return p


# ─── Config loading ────────────────────────────────────────────────────────

def test_load_config_uses_env_vars(monkeypatch):
    monkeypatch.setenv("FLAIR_URL", "http://flair.test:9926")
    monkeypatch.setenv("FLAIR_AGENT_ID", "alpha")
    monkeypatch.setenv("FLAIR_KEY_PATH", "/tmp/alpha.key")
    cfg = flair_plugin._load_config()
    assert cfg["url"] == "http://flair.test:9926"
    assert cfg["agent_id"] == "alpha"
    assert cfg["key_path"] == "/tmp/alpha.key"


def test_load_config_strips_trailing_slash_from_url(monkeypatch):
    monkeypatch.setenv("FLAIR_URL", "http://flair.test:9926/")
    cfg = flair_plugin._load_config()
    assert cfg["url"] == "http://flair.test:9926"


def test_load_config_default_key_path_uses_agent_id(monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "betatron")
    monkeypatch.delenv("FLAIR_KEY_PATH", raising=False)
    cfg = flair_plugin._load_config()
    assert cfg["key_path"].endswith("/.flair/keys/betatron.key")


def test_load_config_json_overrides_env(monkeypatch, tmp_path):
    monkeypatch.setenv("FLAIR_AGENT_ID", "from-env")
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "flair.json").write_text(json.dumps({"agent_id": "from-json"}))

    sys.modules["hermes_constants"].get_hermes_home = lambda: home
    try:
        cfg = flair_plugin._load_config()
        assert cfg["agent_id"] == "from-json"
    finally:
        sys.modules["hermes_constants"].get_hermes_home = lambda: Path(tempfile.gettempdir()) / "hermes-test-home"


# ─── Ed25519 signing ───────────────────────────────────────────────────────

def test_load_private_key_round_trip(ed25519_key_file):
    key = flair_plugin._load_private_key(str(ed25519_key_file))
    # Should be able to sign without raising
    sig = key.sign(b"hello")
    assert isinstance(sig, bytes) and len(sig) == 64  # Ed25519 sig is 64 bytes


def test_load_private_key_raw_seed_written_by_flair_agent_add(tmp_path):
    """`flair agent add` writes a raw 32-byte seed (src/commands/agent.ts).
    The plugin must load THAT file and sign a request that verifies with the
    matching public key."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    priv = ed25519.Ed25519PrivateKey.generate()
    seed = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    assert len(seed) == 32
    path = tmp_path / "hermes.key"
    path.write_bytes(seed)  # exactly how `flair agent add` writes it

    key = flair_plugin._load_private_key(str(path))
    auth = flair_plugin._sign_request(key, "alpha", "GET", "/Memory/abc")
    agent_id, ts, nonce, sig_b64 = auth[len("TPS-Ed25519 "):].split(":")
    payload = f"{agent_id}:{ts}:{nonce}:GET:/Memory/abc".encode("utf-8")
    # Verifies with the matching public key (raises on failure).
    priv.public_key().verify(base64.b64decode(sig_b64), payload)
    assert key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    ) == priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )


def test_load_private_key_rejects_unknown_format_with_clear_error(tmp_path):
    path = tmp_path / "garbage.key"
    path.write_bytes(b"not-a-key")
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    msg = str(ei.value)
    assert str(path) in msg  # names the path
    assert "32-byte raw seed" in msg  # names the accepted formats


def _pem_text() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    return ed25519.Ed25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


def test_load_private_key_accepts_a_whole_pem_block(tmp_path):
    path = tmp_path / "whole.pem"
    path.write_text(_pem_text(), encoding="utf-8")
    key = flair_plugin._load_private_key(str(path))
    assert key.sign(b"x") is not None


def test_load_private_key_rejects_invalid_utf8_inserted_into_base64(tmp_path):
    # Invalid UTF-8 inserted into otherwise-valid canonical base64: the old
    # errors="ignore" decode silently dropped the byte and LOADED the key; a
    # strict decode must REFUSE with the named error, never clean it.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    der = ed25519.Ed25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    encoded = base64.b64encode(der)
    raw = encoded[:5] + b"\xff" + encoded[5:]  # insert an invalid UTF-8 byte
    assert len(raw) != 32
    path = tmp_path / "bad-utf8.key"
    path.write_bytes(raw)
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    assert str(path) in str(ei.value)  # names the path


def test_load_private_key_rejects_junk_before_a_pem_block(tmp_path):
    path = tmp_path / "junk-before.pem"
    path.write_text("junk line\n" + _pem_text(), encoding="utf-8")
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    assert str(path) in str(ei.value)


def test_load_private_key_rejects_junk_after_a_pem_block(tmp_path):
    path = tmp_path / "junk-after.pem"
    path.write_text(_pem_text() + "\nJUNK", encoding="utf-8")
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    assert str(path) in str(ei.value)


def test_canonical_base64_requires_padding_that_round_trips():
    # A payload length that needs '=' padding: 47 bytes -> one pad char.
    payload = bytes(range(47))
    encoded = base64.b64encode(payload).decode("ascii")
    assert encoded.endswith("=")  # assertion: this length is padded
    assert flair_plugin._canonical_base64_decode(encoded) == payload  # assertion: padded round-trips
    # The unpadded spelling is non-canonical and refused.
    assert flair_plugin._canonical_base64_decode(encoded.rstrip("=")) is None  # assertion


def test_round_trip_guard_refuses_a_pad_bit_alias():
    # Same bytes, non-canonical spelling: the unused low bits of the last data
    # character are set. b64decode(validate=True) accepts it; only the
    # round-trip comparison refuses it.
    payload = bytes(range(47))
    encoded = base64.b64encode(payload).decode("ascii")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    last = encoded[-2]
    alias = encoded[:-2] + alphabet[alphabet.index(last) | 1] + encoded[-1]
    assert alias != encoded
    assert base64.b64decode(alias, validate=True) == payload  # assertion: decodes to the same bytes
    assert flair_plugin._canonical_base64_decode(alias) is None  # assertion: the guard refuses it


def test_invalid_utf8_error_does_not_chain_the_key_bytes(tmp_path):
    import traceback

    path = tmp_path / "bad.key"
    path.write_bytes(bytes([0xFF] * 40) + b"\n")
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    assert ei.value.__cause__ is None  # assertion: nothing chained
    assert ei.value.__context__ is None  # assertion: the decode error (and its bytes) is not kept
    rendered = "".join(traceback.format_exception(ei.value))
    assert "0xff" not in rendered and "\\xff" not in rendered  # assertion: no key byte in the traceback


def test_format_error_frames_hold_no_key_bytes(tmp_path):
    import traceback

    path = tmp_path / "pem-junk.key"
    path.write_text(_pem_text() + "\nJUNK", encoding="utf-8")
    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    rendered = "".join(
        traceback.TracebackException.from_exception(ei.value, capture_locals=True).format()
    )
    assert "PRIVATE KEY" not in rendered  # assertion: no frame local holds the key text
    assert "JUNK" not in rendered


def test_crypto_import_failure_happens_before_the_key_is_read(tmp_path, monkeypatch):
    import builtins

    path = tmp_path / "any.key"
    path.write_bytes(bytes(32))
    real_import = builtins.__import__

    def failing_import(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ImportError("simulated: cryptography unavailable")
        return real_import(name, *args, **kwargs)

    reads = []
    real_read = flair_plugin.Path.read_bytes
    monkeypatch.setattr(flair_plugin.Path, "read_bytes", lambda self: reads.append(self) or real_read(self))
    monkeypatch.setattr(builtins, "__import__", failing_import)
    with pytest.raises(ImportError):
        flair_plugin._load_private_key(str(path))
    assert reads == []  # assertion: the key file was never read before the import failed


def test_load_private_key_file_read_error_propagates(tmp_path):
    # A missing file is a read error, NOT the named format error.
    with pytest.raises(FileNotFoundError):
        flair_plugin._load_private_key(str(tmp_path / "does-not-exist.key"))


def test_default_url_is_port_19926(monkeypatch):
    assert flair_plugin.DEFAULT_URL == "http://127.0.0.1:19926"
    monkeypatch.delenv("FLAIR_URL", raising=False)
    cfg = flair_plugin._load_config()
    assert cfg["url"] == "http://127.0.0.1:19926"  # Flair's default port


def test_sign_request_format(ed25519_key_file):
    key = flair_plugin._load_private_key(str(ed25519_key_file))
    auth = flair_plugin._sign_request(key, "alpha", "GET", "/Memory/abc")
    assert auth.startswith("TPS-Ed25519 ")
    body = auth[len("TPS-Ed25519 "):]
    parts = body.split(":")
    assert len(parts) == 4
    agent_id, ts, nonce, sig_b64 = parts
    assert agent_id == "alpha"
    assert ts.isdigit()
    assert len(nonce) == 36  # uuid4 length
    sig_bytes = base64.b64decode(sig_b64)
    assert len(sig_bytes) == 64


def test_sign_request_uses_unique_nonces(ed25519_key_file):
    key = flair_plugin._load_private_key(str(ed25519_key_file))
    a1 = flair_plugin._sign_request(key, "alpha", "GET", "/Memory/abc")
    a2 = flair_plugin._sign_request(key, "alpha", "GET", "/Memory/abc")
    nonce1 = a1.split(":")[2]
    nonce2 = a2.split(":")[2]
    assert nonce1 != nonce2  # nonce reuse defeats replay protection


# ─── Provider lifecycle ────────────────────────────────────────────────────

def test_is_available_true_when_key_exists(ed25519_key_file, monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "test-agent")
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    p = flair_plugin.FlairMemoryProvider()
    assert p.is_available() is True


def test_is_available_false_when_key_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("FLAIR_KEY_PATH", str(tmp_path / "does-not-exist.key"))
    p = flair_plugin.FlairMemoryProvider()
    assert p.is_available() is False


def test_initialize_loads_key_and_sets_state(configured_provider):
    assert configured_provider._priv_key is not None
    assert configured_provider._agent_id == "test-agent"
    assert configured_provider._url == "http://test.invalid"


def test_initialize_marks_non_primary_context(ed25519_key_file, monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "test-agent")
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    p = flair_plugin.FlairMemoryProvider()
    with patch.object(p, "_request", return_value=[]):
        p.initialize(session_id="x", agent_context="cron")
    assert p._is_primary is False


# ─── Tool schemas ──────────────────────────────────────────────────────────

def test_tool_schemas_expose_search_and_store(configured_provider):
    schemas = configured_provider.get_tool_schemas()
    names = {s["name"] for s in schemas}
    assert names == {"flair_search", "flair_store"}
    for s in schemas:
        assert "description" in s
        assert "parameters" in s


def test_store_schema_durability_enum(configured_provider):
    store = next(s for s in configured_provider.get_tool_schemas() if s["name"] == "flair_store")
    durability = store["parameters"]["properties"]["durability"]
    assert set(durability["enum"]) == {"permanent", "persistent", "standard", "ephemeral"}


def test_search_description_names_the_read_scope(configured_provider):
    search = next(s for s in configured_provider.get_tool_schemas() if s["name"] == "flair_search")
    desc = search["description"]
    # assertion: the description names the configured agent's own memories ...
    assert "own memories" in desc
    # ... and other agents' non-private memories on the instance.
    assert "non-private memories" in desc


# ─── Tool call dispatch ────────────────────────────────────────────────────

def test_handle_tool_call_search_dispatches_to_semantic(configured_provider):
    with patch.object(configured_provider, "_semantic_search", return_value=[{"id": "x", "content": "hi"}]) as m:
        result = configured_provider.handle_tool_call("flair_search", {"query": "auth", "limit": 3})
    m.assert_called_once_with(query="auth", limit=3)
    assert json.loads(result) == {"results": [{"id": "x", "content": "hi"}]}


def test_handle_tool_call_store_persists_via_request(configured_provider):
    fake_resp = {"id": "test-agent-12345", "ok": True}
    with patch.object(configured_provider, "_request", return_value=fake_resp) as m:
        result = configured_provider.handle_tool_call("flair_store", {
            "content": "Nathan prefers terse responses",
            "durability": "persistent",
            "tags": ["pref:tone"],
        })
    parsed = json.loads(result)
    assert parsed["stored"] is True
    # Verify the PUT body had the right shape
    call_args = m.call_args
    method, path = call_args.args[0], call_args.args[1]
    body = call_args.kwargs.get("json_body") or {}
    assert method == "PUT"
    assert path.startswith("/Memory/test-agent-")
    assert body["agentId"] == "test-agent"
    assert body["content"] == "Nathan prefers terse responses"
    assert body["durability"] == "persistent"
    assert body["tags"] == ["pref:tone"]


def test_store_memory_percent_encodes_id_in_path(ed25519_key_file, monkeypatch):
    """#1970: a Memory id (agent id + timestamp) with reserved URL characters
    reaches the wire as ONE percent-encoded path segment. Before #1970 the raw
    id was interpolated into the path, so '#' started a fragment, '?' a query,
    and '/' split it into extra segments."""
    from urllib.parse import quote, unquote

    agent = "ag#1?x/y%z w"
    monkeypatch.setenv("FLAIR_AGENT_ID", agent)
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    monkeypatch.setenv("FLAIR_URL", "http://test.invalid")
    p = flair_plugin.FlairMemoryProvider()
    with patch.object(p, "_request", return_value=[]):
        p.initialize(session_id="s")
    with patch.object(p, "_request", return_value={"ok": True}) as m:
        result = p.handle_tool_call("flair_store", {"content": "x"})
    assert json.loads(result)["stored"] is True
    method, path = m.call_args.args[0], m.call_args.args[1]
    body_id = m.call_args.kwargs["json_body"]["id"]
    assert method == "PUT"
    segment = path[len("/Memory/"):]
    assert segment == quote(body_id, safe="")  # assertion: one percent-encoded segment
    assert "/" not in segment
    assert "?" not in segment
    assert "#" not in segment
    assert unquote(segment) == body_id


def test_encode_record_id_refuses_dot_segments(monkeypatch):
    """#1970 item 2: an id that is exactly '.' or '..' cannot be addressed as
    one path segment (URL normalization would collapse it); the builder that
    every Memory path goes through refuses it before any request."""
    for bad in (".", ".."):
        with pytest.raises(ValueError, match="dot-segment"):
            flair_plugin._encode_record_id(bad)


def test_store_memory_refuses_dot_segment_id_before_any_request(configured_provider):
    """#1970 item 3: driven through the REAL request path (`_store_memory` builds
    and sends `PUT /Memory/<id>`), each dot-segment id is refused with the
    request seam untouched — nothing is sent."""
    for bad in (".", ".."):
        with patch.object(
            configured_provider,
            "_request",
            side_effect=AssertionError("a request must not be sent for a refused id"),
        ) as spy:
            with pytest.raises(ValueError, match="dot-segment"):
                configured_provider._store_memory("x", "standard", [], memory_id=bad)
            assert not spy.called  # assertion: the request spy is untouched


def test_handle_tool_call_store_skipped_in_non_primary_context(ed25519_key_file, monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "test-agent")
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    p = flair_plugin.FlairMemoryProvider()
    with patch.object(p, "_request", return_value=[]):
        p.initialize(session_id="x", agent_context="cron")
    result = p.handle_tool_call("flair_store", {"content": "should not write"})
    parsed = json.loads(result)
    assert parsed["stored"] is False
    assert "non-primary" in parsed["reason"]


def test_handle_tool_call_unknown_tool_returns_error(configured_provider):
    result = configured_provider.handle_tool_call("flair_nonsense", {})
    parsed = json.loads(result)
    assert "error" in parsed
    assert "unknown tool" in parsed["error"]


def test_handle_tool_call_invalid_durability_falls_back_to_standard(configured_provider):
    fake_resp = {"id": "x", "ok": True}
    with patch.object(configured_provider, "_request", return_value=fake_resp) as m:
        configured_provider.handle_tool_call("flair_store", {
            "content": "x", "durability": "forever-and-ever-amen",
        })
    body = m.call_args.kwargs["json_body"]
    assert body["durability"] == "standard"


# ─── Circuit breaker ───────────────────────────────────────────────────────

def test_circuit_breaker_trips_after_threshold(configured_provider, monkeypatch):
    # Force every request to fail
    with patch.object(configured_provider, "_request", side_effect=RuntimeError("boom")):
        for _ in range(flair_plugin._BREAKER_THRESHOLD):
            configured_provider.handle_tool_call("flair_search", {"query": "x"})
    # Now the breaker should be open; subsequent call returns breaker-error
    result = configured_provider.handle_tool_call("flair_search", {"query": "x"})
    parsed = json.loads(result)
    assert "error" in parsed
    assert "circuit breaker" in parsed["error"]


def test_circuit_breaker_resets_after_cooldown(configured_provider, monkeypatch):
    with patch.object(configured_provider, "_request", side_effect=RuntimeError("boom")):
        for _ in range(flair_plugin._BREAKER_THRESHOLD):
            configured_provider.handle_tool_call("flair_search", {"query": "x"})
    # Fast-forward time past the cooldown
    monkeypatch.setattr(flair_plugin.time, "monotonic", lambda: configured_provider._breaker_open_until + 1)
    # A successful call should reset the breaker
    with patch.object(configured_provider, "_semantic_search", return_value=[]):
        configured_provider.handle_tool_call("flair_search", {"query": "x"})
    assert configured_provider._consecutive_failures == 0


# ─── on_memory_write mirroring ─────────────────────────────────────────────

def test_on_memory_write_mirrors_add_with_builtin_tag(configured_provider):
    fake_resp = {"id": "x", "ok": True}
    with patch.object(configured_provider, "_request", return_value=fake_resp) as m:
        configured_provider.on_memory_write("add", "memory", "Nathan ships at 11pm", metadata={})
    body = m.call_args.kwargs["json_body"]
    assert body["content"] == "Nathan ships at 11pm"
    assert body["durability"] == "persistent"
    assert "hermes-builtin:memory" in body["tags"]


def test_on_memory_write_skips_replace_and_remove(configured_provider):
    with patch.object(configured_provider, "_request", side_effect=AssertionError("should not be called")):
        configured_provider.on_memory_write("replace", "memory", "x", metadata={})
        configured_provider.on_memory_write("remove", "user", "x", metadata={})


def test_on_memory_write_skipped_in_non_primary(ed25519_key_file, monkeypatch):
    monkeypatch.setenv("FLAIR_AGENT_ID", "test-agent")
    monkeypatch.setenv("FLAIR_KEY_PATH", str(ed25519_key_file))
    p = flair_plugin.FlairMemoryProvider()
    with patch.object(p, "_request", return_value=[]):
        p.initialize(session_id="x", agent_context="subagent")
    with patch.object(p, "_request", side_effect=AssertionError("should not be called")):
        p.on_memory_write("add", "memory", "should not mirror", metadata={})

# ─── Base64-encoded raw seed (issue #1968) ─────────────────────────────────

import base64 as _b64mod

def test_b64_44_char_seed_loads_and_signs(tmp_path):
    """A 44-character base64 of a 32-byte seed loads, and the signature
    verifies with the matching public key (flair#1968)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    priv = ed25519.Ed25519PrivateKey.generate()
    seed = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    assert len(seed) == 32
    seed_b64 = _b64mod.b64encode(seed).decode("ascii")
    assert len(seed_b64) == 44  # 32 bytes -> 44 base64 chars

    path = tmp_path / "b64seed.key"
    path.write_text(seed_b64, encoding="utf-8")

    key = flair_plugin._load_private_key(str(path))
    auth = flair_plugin._sign_request(key, "beta", "POST", "/Memory/xyz")
    assert auth.startswith("TPS-Ed25519 ")
    # Signature verifies with the matching public key
    agent_id, ts, nonce, sig_b64 = auth[len("TPS-Ed25519 "):].split(":")
    payload = f"{agent_id}:{ts}:{nonce}:POST:/Memory/xyz".encode("utf-8")
    priv.public_key().verify(_b64mod.b64decode(sig_b64), payload)


def test_b64_decodes_to_31_bytes_is_refused(tmp_path):
    """A base64 string that decodes to 31 bytes is refused with the named
    format error, and no key material in the message.
    The canonical decoder accepts it, but it is not 32 bytes, so it is not
    taken for a seed; it falls through to PKCS8 DER parsing, which fails."""
    seed = b"\x00" * 31  # 31 zero bytes
    seed_b64 = _b64mod.b64encode(seed).decode("ascii")
    assert len(seed_b64) == 44  # padding: ceil(31/3)*4 = 44

    path = tmp_path / "short.key"
    path.write_text(seed_b64, encoding="utf-8")

    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    msg = str(ei.value)
    assert str(path) in msg  # names the path
    assert "32-byte" in msg  # names the accepted formats
    assert seed_b64 not in msg  # no key material


def test_b64_decodes_to_33_bytes_is_refused(tmp_path):
    """A base64 string that decodes to 33 bytes is refused with the named
    format error, and no key material in the message.
    The canonical decoder accepts it, but it is not 32 bytes, so it is not
    taken for a seed; it falls through to PKCS8 DER parsing, which fails."""
    seed = b"\x00" * 33  # 33 zero bytes
    seed_b64 = _b64mod.b64encode(seed).decode("ascii")
    assert len(seed_b64) == 44  # ceil(33/3)*4 = 44

    path = tmp_path / "long.key"
    path.write_text(seed_b64, encoding="utf-8")

    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    msg = str(ei.value)
    assert str(path) in msg  # names the path
    assert "32-byte" in msg  # names the accepted formats
    assert seed_b64 not in msg  # no key material


def test_non_canonical_b64_of_32_bytes_is_refused(tmp_path):
    """An unpadded base64 of 32 bytes is refused: it is NOT decoded to
    anything. The base64 decoder's padding validation (validate=True) rejects
    the missing padding, so neither the 32-byte gate nor DER parsing runs."""
    # Generate payload that produces a non-canonical base64
    payload = b"\x00" * 32
    canonical = _b64mod.b64encode(payload).decode("ascii")  # padded
    assert canonical.endswith("=")  # payload needs padding

    # Strip the padding to make it non-canonical
    non_canon = canonical.rstrip("=")
    assert len(non_canon) < len(canonical)

    path = tmp_path / "noncanon.key"
    path.write_text(non_canon, encoding="utf-8")

    with pytest.raises(ValueError) as ei:
        flair_plugin._load_private_key(str(path))
    msg = str(ei.value)
    assert str(path) in msg  # names the path
    assert "32-byte" in msg  # names the accepted formats
