"""Shared test fixtures for adk-flair integration tests.

Provides a `live_flair` fixture that either connects to an existing Flair
instance (FLAIR_TEST_URL) or boots an ephemeral Harper via the repo's
harper-lifecycle helper. Tests that need a live Flair should request this
fixture; it SKIPs with a visible reason when no live Flair is configured.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

import pytest
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

# ─── Paths ───────────────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[3]  # flair repo root (tests → adk-flair → packages → repo)
_BOOT_HELPER = Path(__file__).resolve().parent / "helpers" / "boot-harper.mjs"


# ─── Ed25519 key generation ──────────────────────────────────────────────────


def generate_ed25519_keypair() -> tuple[ed25519.Ed25519PrivateKey, str]:
    """Generate a fresh Ed25519 keypair. Returns (private_key, public_key_b64)."""
    private_key = ed25519.Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    public_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    public_b64 = base64.b64encode(public_bytes).decode("ascii")
    return private_key, public_b64


def private_key_to_pkcs8_b64(private_key: ed25519.Ed25519PrivateKey) -> str:
    """Serialize an Ed25519 private key to PKCS8 base64 (Flair keyfile format)."""
    der = private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(der).decode("ascii")


# ─── Agent registration via ops API ──────────────────────────────────────────


async def register_agent(
    ops_url: str,
    admin_user: str,
    admin_pass: str,
    agent_id: str,
    public_key_b64: str,
) -> None:
    """Register a test agent in Flair via the ops API."""
    import base64 as b64_mod

    auth = b64_mod.b64encode(f"{admin_user}:{admin_pass}".encode()).decode()
    async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
        resp = await client.post(
            ops_url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Basic {auth}",
            },
            json={
                "operation": "insert",
                "database": "flair",
                "table": "Agent",
                "records": [
                    {
                        "id": agent_id,
                        "name": agent_id,
                        "role": "agent",
                        "publicKey": public_key_b64,
                        "createdAt": _iso_now(),
                    }
                ],
            },
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Agent registration failed: HTTP {resp.status_code}"
            )


def _iso_now() -> str:
    """ISO 8601 timestamp with millisecond precision in UTC."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


# ─── Live Flair fixture ──────────────────────────────────────────────────────


class LiveFlair:
    """Holds connection details for a live Flair instance.

    admin_pass is stored privately and redacted from repr to prevent
    credential leaks in pytest failure output when FLAIR_TEST_URL points
    at a real (non-ephemeral) instance.
    """

    def __init__(
        self,
        http_url: str,
        ops_url: str,
        admin_user: str,
        admin_pass: str,
        agent_id: str,
        private_key: ed25519.Ed25519PrivateKey,
        keyfile_path: str,
        harper_proc: Optional[subprocess.Popen] = None,
    ):
        self.http_url = http_url
        self.ops_url = ops_url
        self.admin_user = admin_user
        self._admin_pass = admin_pass
        self.agent_id = agent_id
        self.private_key = private_key
        self.keyfile_path = keyfile_path
        self._harper_proc = harper_proc

    @property
    def admin_pass(self) -> str:
        """Admin password — available to callers but redacted in repr."""
        return self._admin_pass

    def __repr__(self) -> str:
        return (
            f"LiveFlair(http_url={self.http_url!r}, ops_url={self.ops_url!r}, "
            f"admin_user={self.admin_user!r}, admin_pass='***', "
            f"agent_id={self.agent_id!r})"
        )

    def cleanup(self):
        """Tear down ephemeral Harper if we spawned it."""
        if self._harper_proc is not None:
            try:
                self._harper_proc.terminate()
                self._harper_proc.wait(timeout=10)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self._harper_proc.kill()
                    self._harper_proc.wait(timeout=5)
                except OSError:
                    pass


@pytest.fixture(scope="session")
def live_flair():
    """Session-scoped fixture: a live Flair instance with a registered test agent.

    Set FLAIR_TEST_URL to use an existing Flair instance. Otherwise, boots an
    ephemeral Harper via the repo's harper-lifecycle helper.

    SKIPs with a visible reason when no live Flair is configured and the
    ephemeral boot fails or is unavailable.
    """
    test_url = os.environ.get("FLAIR_TEST_URL", "")

    if test_url:
        # ── External mode: use the provided Flair instance ──────────────────
        ops_url = os.environ.get("FLAIR_TEST_OPS_URL", "")
        admin_user = os.environ.get("FLAIR_TEST_ADMIN_USER", "admin")
        admin_pass = os.environ.get("FLAIR_TEST_ADMIN_PASS", "test123")
        agent_id = os.environ.get("FLAIR_TEST_AGENT_ID", f"adk-integration-test-{uuid.uuid4().hex[:8]}")

        if not ops_url:
            # Derive ops URL from http URL (ops port = http port - 1)
            from urllib.parse import urlparse
            parsed = urlparse(test_url)
            ops_port = (parsed.port or 19926) - 1
            ops_url = f"{parsed.scheme}://{parsed.hostname}:{ops_port}"

        private_key, public_b64 = generate_ed25519_keypair()
        keyfile_content = private_key_to_pkcs8_b64(private_key)

        # Write keyfile to temp location
        keyfile_path = os.path.join(
            os.environ.get("TMPDIR", "/tmp"),
            f"adk-flair-test-{agent_id}.key",
        )
        Path(keyfile_path).write_text(keyfile_content, encoding="utf-8")

        # Register agent
        import asyncio
        asyncio.run(
            register_agent(ops_url, admin_user, admin_pass, agent_id, public_b64)
        )

        inst = LiveFlair(
            http_url=test_url,
            ops_url=ops_url,
            admin_user=admin_user,
            admin_pass=admin_pass,
            agent_id=agent_id,
            private_key=private_key,
            keyfile_path=keyfile_path,
        )
        yield inst
        inst.cleanup()
        # Clean up keyfile
        try:
            os.unlink(keyfile_path)
        except OSError:
            pass
        return

    # ── Ephemeral mode: boot Harper via the Node.js helper ───────────────────
    if not _BOOT_HELPER.exists():
        pytest.skip(
            "FLAIR_TEST_URL not set and boot-harper.mjs helper not found — "
            "set FLAIR_TEST_URL to a running Flair instance to run integration tests"
        )

    # Check that bun or node is available (bun preferred — can import .ts)
    node_bin = None
    for candidate in ["bun", "node"]:
        try:
            subprocess.run([candidate, "--version"], capture_output=True, check=True)
            node_bin = candidate
            break
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue

    if node_bin is None:
        pytest.skip(
            "FLAIR_TEST_URL not set and neither bun nor node is available — "
            "set FLAIR_TEST_URL to a running Flair instance to run integration tests"
        )

    # ── Build gate: the repo must be built before Harper can serve ─────────
    _dist_dir = _REPO_ROOT / "dist"
    if not _dist_dir.is_dir() or not any(_dist_dir.iterdir()):
        # Try to build; if that fails, fail loudly naming the missing build
        try:
            subprocess.run(
                [node_bin, "node_modules/.bin/tsc", "-p", "tsconfig.json", "--noCheck"],
                cwd=str(_REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=120,
                check=True,
            )
        except subprocess.CalledProcessError as build_err:
            pytest.skip(
                f"FLAIR_TEST_URL not set and repo dist/ is missing — "
                f"auto-build failed (exit {build_err.returncode}): "
                f"{build_err.stderr[:1000]}"
            )
        except FileNotFoundError:
            pytest.skip(
                "FLAIR_TEST_URL not set and repo dist/ is missing — "
                "tsc not found; run 'npm run build' first or set FLAIR_TEST_URL"
            )
        if not _dist_dir.is_dir() or not any(_dist_dir.iterdir()):
            pytest.skip(
                "FLAIR_TEST_URL not set and repo dist/ is missing — "
                "build completed but dist/ is still empty; "
                "run 'npm run build' manually or set FLAIR_TEST_URL"
            )

    # Spawn the boot helper
    proc = subprocess.Popen(
        [node_bin, str(_BOOT_HELPER)],
        cwd=str(_REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        text=True,
    )

    # Scan stdout for the JSON config line.
    #
    # boot-harper.mjs emits the Harper connection config as a single JSON line on
    # stdout, but harper-lifecycle prints progress lines ("[harper-lifecycle] …")
    # to stdout BEFORE it. Reading only the first line and json-parsing it fails
    # on those logs ("Expecting value: line 1 column 2"), so every ephemeral test
    # skipped even after the repo root was resolved correctly. Scan each line and
    # take the first that parses as the expected config dict — mirrors the JS
    # live-flair helper. boot-harper self-bounds (startup/health/warm-up timeouts)
    # and exits on failure, closing stdout (EOF) so this loop terminates.
    config = None
    try:
        while True:
            line = proc.stdout.readline()
            if not line:  # EOF — boot-harper exited without emitting config
                break
            line = line.strip()
            if not line:
                continue
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue  # a harper-lifecycle progress log — keep scanning
            if not isinstance(candidate, dict):
                continue
            if candidate.get("httpURL") and candidate.get("opsURL"):
                config = candidate
                break
            if candidate.get("outcome") == "FLOOR-EXCEEDED":
                # Capability gate (flair#1119): runner can't reach operating
                # latency. Not a code defect — skip cleanly.
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except Exception:
                    pass
                pytest.skip(
                    f"ephemeral Harper floor-exceeded (runner too slow): {candidate}"
                )
    except Exception as exc:
        stderr_output = ""
        try:
            proc.kill()
            proc.wait(timeout=5)
            stderr_output = proc.stderr.read()
        except Exception:
            pass
        pytest.skip(
            f"FLAIR_TEST_URL not set and ephemeral Harper config read failed: {exc}. "
            f"stderr={stderr_output}"
        )

    if config is None:
        stderr_output = ""
        try:
            proc.kill()
            proc.wait(timeout=5)
            stderr_output = proc.stderr.read()
        except Exception:
            pass
        pytest.skip(
            "FLAIR_TEST_URL not set and ephemeral Harper produced no config line. "
            f"stderr={stderr_output}"
        )

    http_url = config["httpURL"]
    ops_url = config["opsURL"]
    admin_user = config["adminUser"]
    admin_pass = config["adminPass"]
    agent_id = f"adk-integration-test-{uuid.uuid4().hex[:8]}"

    # Generate keypair and register agent
    private_key, public_b64 = generate_ed25519_keypair()
    keyfile_content = private_key_to_pkcs8_b64(private_key)
    keyfile_path = os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"adk-flair-test-{agent_id}.key",
    )
    Path(keyfile_path).write_text(keyfile_content, encoding="utf-8")

    import asyncio
    asyncio.run(
        register_agent(ops_url, admin_user, admin_pass, agent_id, public_b64)
    )

    inst = LiveFlair(
        http_url=http_url,
        ops_url=ops_url,
        admin_user=admin_user,
        admin_pass=admin_pass,
        agent_id=agent_id,
        private_key=private_key,
        keyfile_path=keyfile_path,
        harper_proc=proc,
    )

    yield inst

    # Teardown
    inst.cleanup()
    try:
        os.unlink(keyfile_path)
    except OSError:
        pass


# ─── Shared fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def app_name():
    return "test-app"


@pytest.fixture
def user_id():
    return "test-user"


@pytest.fixture
def session_id():
    return "test-session-123"


@pytest.fixture
def compound_tag(app_name, user_id):
    from adk_flair.memory_service import _compound_tag
    return _compound_tag(app_name, user_id)
