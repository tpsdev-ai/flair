"""adk-flair — Flair as the memory backend for Google ADK.

Provides FlairMemoryService, a BaseMemoryService implementation that persists
ADK agent memory into a Flair instance.

Quickstart:
    from adk_flair import FlairMemoryService

    memory_service = FlairMemoryService(
        url="http://localhost:19926",
        agent_id="my-adk-app",
        keyfile="/home/agent/.flair/keys/my-adk-app.key",
    )

CLI / dev UI (requires services.py in your agent directory):
    adk web --memory_service_uri="flair://localhost:19926"

For the services.py registration, copy the register() call below into your
agent's services.py, or use services.yaml:

    services:
      - scheme: flair
        type: memory
        class: adk_flair.memory_service.FlairMemoryService
"""

from adk_flair.memory_service import FlairMemoryService

__all__ = ["FlairMemoryService", "register"]


def register():
    """Register the flair:// URI scheme with ADK's service registry.

    Call this from your agent's services.py:

        from adk_flair import register
        register()
    """
    from google.adk.cli.service_registry import get_service_registry

    def _flair_factory(uri: str, **kwargs):
        """Factory for flair:// URIs. Extracts host:port from the URI."""
        from urllib.parse import urlparse

        parsed = urlparse(uri)
        host = parsed.hostname or "localhost"
        port = parsed.port or 19926
        url = f"http://{host}:{port}"

        # Allow agent_id override from kwargs (e.g. from adk web flags)
        agent_id = kwargs.pop("agent_id", None)
        keyfile = kwargs.pop("keyfile", None)

        return FlairMemoryService(url=url, agent_id=agent_id, keyfile=keyfile)

    get_service_registry().register_memory_service("flair", _flair_factory)
