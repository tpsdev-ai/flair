"""Unit tests for the Hermes-Flair memory plugin.

Tests run without Hermes installed by stubbing the two Hermes-side imports
(`agent.memory_provider` and `tools.registry`). Real-Hermes integration is
covered by the plugin's appearance in upstream Hermes CI once landed.

Run: python -m pytest plugins/hermes-flair/test_plugin.py -v
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
