"""Agent Engine boot shim: Secret Manager key -> keyfile, then flair:// registration.

Staged via ``--extra_packages`` so it lands at ``/app/services.py`` in the
Agent Engine container (each extra package is placed at ``/app/<basename>``
and ``/app`` joins PYTHONPATH). The container's entrypoint is
``adk api_server ... /app/agents``; at startup ADK imports a top-level
``services`` module (google.adk.cli.service_registry.load_services_module)
BEFORE it resolves ``--memory_service_uri`` — so everything in this file runs
exactly once, before FlairMemoryService is constructed.

Order matters:

1. ``FLAIR_ED25519_KEY`` — delivered by Agent Engine as a plain env var from a
   Secret Manager reference in the deploy config (``env_vars`` with a
   ``{"secret": ..., "version": ...}`` value) — is written to an owner-only
   file. adk-flair reads the key from a PATH (``FLAIR_KEYFILE``); there is no
   key-material env var in the connector, by design.
2. ``FLAIR_KEYFILE`` is pointed at that file, in-process.
3. The key-material env var is scrubbed from this process so child processes
   and debug env dumps don't carry it. (The container's environment still
   holds the value — this narrows exposure, it does not eliminate it.)
4. ``adk_flair.register()`` makes the ``flair://`` scheme resolvable.

FlairMemoryService validates the keyfile eagerly in its constructor, so a
missing or invalid key fails the container at boot — loudly, in Cloud Logging
— rather than on the first chat turn.
"""

from __future__ import annotations

import os

_KEY_ENV = "FLAIR_ED25519_KEY"
_KEYFILE_ENV = "FLAIR_KEYFILE"
_KEY_PATH = "/tmp/flair/agent.key"


def _materialize_keyfile() -> None:
    if os.environ.get(_KEYFILE_ENV):
        # An explicit keyfile (e.g. local api_server testing) wins.
        return
    material = os.environ.get(_KEY_ENV, "")
    if not material:
        raise RuntimeError(
            f"Neither {_KEYFILE_ENV} nor {_KEY_ENV} is set. The deploy config "
            f"must deliver the agent's Ed25519 key as the {_KEY_ENV} env var "
            'via a Secret Manager reference ("env_vars": {"'
            f"{_KEY_ENV}"
            '": {"secret": "<secret-id>", "version": "latest"}}) — '
            "see deploy.sh / RUNBOOK.md — or FLAIR_KEYFILE must point at an "
            "existing keyfile."
        )
    os.makedirs(os.path.dirname(_KEY_PATH), mode=0o700, exist_ok=True)
    fd = os.open(_KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, material.encode("utf-8"))
    finally:
        os.close(fd)
    os.environ[_KEYFILE_ENV] = _KEY_PATH
    del os.environ[_KEY_ENV]


_materialize_keyfile()

from adk_flair import register  # noqa: E402  — import only after key delivery

register()
