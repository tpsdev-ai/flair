"""adk-flair — Flair as the memory backend for Google ADK.

Provides FlairMemoryService, a BaseMemoryService implementation that persists
ADK agent memory into a Flair instance, and create_flair_tools, a factory for
pre-built agent tools (store_memory / search_memory / list_memories) bound to
an explicit service + app/user scope.

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
from adk_flair.tools import create_flair_tools

__all__ = ["FlairMemoryService", "create_flair_tools", "register"]


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
        scheme = "http" if host.lower() in ("localhost", "127.0.0.1", "::1", "[::1]") else "https"
        url = f"{scheme}://{host}:{port}"

        # Allow agent_id override from kwargs (e.g. from adk web flags)
        agent_id = kwargs.pop("agent_id", None)
        keyfile = kwargs.pop("keyfile", None)

        return FlairMemoryService(url=url, agent_id=agent_id, keyfile=keyfile)

    get_service_registry().register_memory_service("flair", _flair_factory)
