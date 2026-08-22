"""Tests for flair#1331 — pre-built ADK agent tools (create_flair_tools).

Two tiers, same split as the rest of the suite:

  - Hermetic (default lane, ``-m "not live_flair"``): factory binding and
    validation, per-tool delegation onto a mocked FlairMemoryService, error
    shapes, JSON-serializability, and the schema-generation smoke test that
    runs the INSTALLED google-adk's own FunctionTool declaration build over
    the returned callables.

  - Live (``@pytest.mark.live_flair``): the tool-level round-trip against a
    real ephemeral Harper — store via tool → search via tool → list via tool.
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from google.adk.memory.base_memory_service import SearchMemoryResponse
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.tools.function_tool import FunctionTool
from google.genai import types

from adk_flair import create_flair_tools
from adk_flair.memory_service import FlairMemoryService


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _mock_service() -> MagicMock:
    """A FlairMemoryService stand-in with async method mocks.

    spec'd to the real class so a tool delegating to a method that does not
    exist (or misspelling a kwarg target) fails here instead of in prod.
    """
    svc = MagicMock(spec=FlairMemoryService)
    svc.add_memory = AsyncMock(return_value=None)
    svc.search_memory = AsyncMock(return_value=SearchMemoryResponse(memories=[]))
    svc.list_memories = AsyncMock(return_value=[])
    return svc


def _entry(text: str, *, entry_id: str = None, meta: dict = None) -> MemoryEntry:
    return MemoryEntry(
        id=entry_id or f"mem-{uuid.uuid4().hex[:8]}",
        content=types.Content(role="model", parts=[types.Part(text=text)]),
        author="agent-a",
        timestamp="2026-08-22T00:00:00.000Z",
        custom_metadata=meta or {},
    )


@pytest.fixture
def service():
    return _mock_service()


@pytest.fixture
def tools(service):
    return create_flair_tools(service, app_name="app", user_id="user")


@pytest.fixture
def store(tools):
    return tools[0]


@pytest.fixture
def search(tools):
    return tools[1]


@pytest.fixture
def listing(tools):
    return tools[2]


# ─── Hermetic: factory ───────────────────────────────────────────────────────


class TestFactory:
    def test_returns_three_named_async_tools(self, tools):
        import inspect

        assert [f.__name__ for f in tools] == [
            "store_memory", "search_memory", "list_memories",
        ]
        for f in tools:
            assert inspect.iscoroutinefunction(f), f.__name__
            assert f.__doc__ and f.__doc__.strip(), f.__name__

    def test_scope_params_are_keyword_only(self, service):
        """The scope must be named at the call site — auditable wiring."""
        with pytest.raises(TypeError):
            create_flair_tools(service, "app", "user")

    def test_empty_app_name_rejected_at_factory_time(self, service):
        with pytest.raises(ValueError, match="app_name"):
            create_flair_tools(service, app_name="", user_id="user")

    def test_empty_user_id_rejected_at_factory_time(self, service):
        with pytest.raises(ValueError, match="user_id"):
            create_flair_tools(service, app_name="app", user_id="")

    def test_non_service_rejected(self):
        with pytest.raises(TypeError, match="FlairMemoryService"):
            create_flair_tools(object(), app_name="app", user_id="user")

    async def test_two_factories_bind_independent_scopes(self):
        """Closure binding control: two tool sets never share scope/service."""
        svc_a, svc_b = _mock_service(), _mock_service()
        search_a = create_flair_tools(svc_a, app_name="app-a", user_id="ua")[1]
        search_b = create_flair_tools(svc_b, app_name="app-b", user_id="ub")[1]

        await search_a(query="q")
        await search_b(query="q")

        assert svc_a.search_memory.await_count == 1
        assert svc_b.search_memory.await_count == 1
        assert svc_a.search_memory.await_args.kwargs["app_name"] == "app-a"
        assert svc_a.search_memory.await_args.kwargs["user_id"] == "ua"
        assert svc_b.search_memory.await_args.kwargs["app_name"] == "app-b"
        assert svc_b.search_memory.await_args.kwargs["user_id"] == "ub"


# ─── Hermetic: store_memory delegation ───────────────────────────────────────


class TestStoreMemory:
    async def test_delegates_with_bound_scope_and_subject(self, service, store):
        result = await store(subject="Title", description="the fact")

        service.add_memory.assert_awaited_once()
        kwargs = service.add_memory.await_args.kwargs
        assert kwargs["app_name"] == "app"
        assert kwargs["user_id"] == "user"
        assert kwargs["subject"] == "Title"
        assert kwargs["custom_metadata"] is None
        [entry] = kwargs["memories"]
        assert entry.content.parts[0].text == "the fact"
        assert result == {"status": "stored", "subject": "Title"}

    async def test_tags_land_in_custom_metadata_blob(self, service, store):
        await store(subject="s", description="d", tags=["a", "b"])
        kwargs = service.add_memory.await_args.kwargs
        assert kwargs["custom_metadata"] == {"tags": ["a", "b"]}

    async def test_tags_merge_with_metadata_param_wins_over_blob_key(
        self, service, store
    ):
        await store(
            subject="s", description="d", tags=["real"],
            custom_metadata={"tags": ["blob"], "source": "chat"},
        )
        kwargs = service.add_memory.await_args.kwargs
        assert kwargs["custom_metadata"] == {"tags": ["real"], "source": "chat"}

    async def test_tags_never_reach_a_tags_kwarg(self, service, store):
        """The record's top-level tags array is the scope boundary — the tool
        must not offer the service any path into it."""
        await store(subject="s", description="d", tags=["adk:app:other-user"])
        assert "tags" not in service.add_memory.await_args.kwargs

    async def test_caller_metadata_dict_is_not_mutated(self, service, store):
        theirs = {"source": "chat"}
        await store(subject="s", description="d", tags=["t"], custom_metadata=theirs)
        assert theirs == {"source": "chat"}

    async def test_empty_description_errors_without_service_call(
        self, service, store
    ):
        result = await store(subject="s", description="   ")
        assert "error" in result and "description" in result["error"]
        service.add_memory.assert_not_awaited()

    async def test_service_valueerror_becomes_error_dict(self, service, store):
        service.add_memory.side_effect = ValueError("subject is 600 characters")
        result = await store(subject="x" * 600, description="d")
        assert result == {"error": "subject is 600 characters"}


# ─── Hermetic: search_memory delegation ──────────────────────────────────────


class TestSearchMemory:
    async def test_delegates_query_with_bound_scope(self, service, search):
        await search(query="what does the user eat")
        service.search_memory.assert_awaited_once_with(
            app_name="app", user_id="user", query="what does the user eat",
        )

    async def test_limit_slices_results(self, service, search):
        service.search_memory.return_value = SearchMemoryResponse(
            memories=[_entry(f"m{i}") for i in range(7)]
        )
        result = await search(query="q", limit=5)
        assert result["count"] == 5
        assert len(result["memories"]) == 5
        assert [m["content"] for m in result["memories"]] == [
            "m0", "m1", "m2", "m3", "m4",
        ]

    async def test_entry_mapping_hoists_subject(self, service, search):
        service.search_memory.return_value = SearchMemoryResponse(
            memories=[_entry("body", entry_id="id-1",
                             meta={"subject": "Title", "k": 1})]
        )
        result = await search(query="q")
        [m] = result["memories"]
        assert m == {
            "id": "id-1",
            "subject": "Title",
            "content": "body",
            "author": "agent-a",
            "timestamp": "2026-08-22T00:00:00.000Z",
            "custom_metadata": {"subject": "Title", "k": 1},
        }

    async def test_no_subject_maps_to_none(self, service, search):
        service.search_memory.return_value = SearchMemoryResponse(
            memories=[_entry("plain")]
        )
        [m] = (await search(query="q"))["memories"]
        assert m["subject"] is None
        assert m["custom_metadata"] == {}

    async def test_invalid_limit_errors_without_service_call(
        self, service, search
    ):
        result = await search(query="q", limit=0)
        assert "error" in result and "limit" in result["error"]
        service.search_memory.assert_not_awaited()

    async def test_empty_results_shape(self, search):
        assert await search(query="q") == {"count": 0, "memories": []}


# ─── Hermetic: list_memories delegation ──────────────────────────────────────


class TestListMemories:
    async def test_delegates_limit_and_offset_with_bound_scope(
        self, service, listing
    ):
        await listing(limit=30, offset=10)
        service.list_memories.assert_awaited_once_with(
            app_name="app", user_id="user", limit=30, offset=10,
        )

    async def test_defaults(self, service, listing):
        await listing()
        kwargs = service.list_memories.await_args.kwargs
        assert kwargs["limit"] == 20 and kwargs["offset"] == 0

    async def test_result_shape(self, service, listing):
        service.list_memories.return_value = [
            _entry("newest", meta={"subject": "N"}), _entry("older"),
        ]
        result = await listing(offset=2)
        assert result["count"] == 2
        assert result["offset"] == 2
        assert [m["content"] for m in result["memories"]] == ["newest", "older"]

    async def test_service_valueerror_becomes_error_dict(self, service, listing):
        service.list_memories.side_effect = ValueError(
            "limit 500 exceeds the hard cap of 200"
        )
        result = await listing(limit=500)
        assert result == {"error": "limit 500 exceeds the hard cap of 200"}

    async def test_transport_error_becomes_error_dict(self, service, listing):
        """The service PROPAGATES transport failures by contract; the tool
        converts them — a model needs a message, not a traceback."""
        service.list_memories.side_effect = httpx.ConnectError("down")
        result = await listing()
        assert "error" in result and "ConnectError" in result["error"]


# ─── Hermetic: return values are JSON-serializable ──────────────────────────


class TestJsonSerializable:
    async def test_every_tool_result_survives_json_dumps(
        self, service, store, search, listing
    ):
        service.search_memory.return_value = SearchMemoryResponse(
            memories=[_entry("m", meta={"subject": "S", "n": [1, 2]})]
        )
        service.list_memories.return_value = [_entry("m")]
        for result in (
            await store(subject="s", description="d", tags=["t"],
                        custom_metadata={"k": {"deep": True}}),
            await search(query="q"),
            await listing(),
            await store(subject="s", description=""),  # error shape too
        ):
            json.dumps(result)  # raises TypeError on any non-JSON value


# ─── Hermetic: schema generation against the installed google-adk ───────────


def _declaration(func):
    """Run the installed google-adk's own declaration build over a tool."""
    decl = FunctionTool(func)._get_declaration()
    assert decl is not None, f"{func.__name__}: no declaration generated"
    return decl


def _decl_properties_and_required(decl):
    """Normalize across the two declaration shapes google-adk emits
    (types.Schema `parameters` vs raw JSON-schema `parameters_json_schema`,
    selected by the JSON_SCHEMA_FOR_FUNC_DECL feature flag)."""
    js = getattr(decl, "parameters_json_schema", None)
    if js:
        return set(js.get("properties", {})), set(js.get("required", []))
    params = decl.parameters
    if params is None:
        return set(), set()
    return set(params.properties or {}), set(params.required or [])


class TestSchemaGeneration:
    def test_declarations_generate_for_all_three_tools(self, tools):
        for func in tools:
            decl = _declaration(func)
            assert decl.name == func.__name__
            assert decl.description and decl.description.strip()

    def test_store_memory_declaration_params(self, store):
        props, required = _decl_properties_and_required(_declaration(store))
        assert props == {"subject", "description", "tags", "custom_metadata"}
        assert required == {"subject", "description"}

    def test_search_memory_declaration_params(self, search):
        props, required = _decl_properties_and_required(_declaration(search))
        assert props == {"query", "limit"}
        assert required == {"query"}

    def test_list_memories_declaration_params(self, listing):
        props, required = _decl_properties_and_required(_declaration(listing))
        assert props == {"limit", "offset"}
        assert required == set()

    def test_scope_never_appears_in_any_declaration(self, tools):
        """The model must not be offered the scope: no app_name/user_id/
        memory_service parameter may surface in any declaration."""
        for func in tools:
            props, _ = _decl_properties_and_required(_declaration(func))
            assert not props & {"app_name", "user_id", "memory_service"}, (
                f"{func.__name__} leaks scope params into its declaration"
            )

    async def test_function_tool_run_async_invokes_the_bare_callable(
        self, service, search
    ):
        """End-to-end through ADK's own FunctionTool invocation path — proves
        bare async callables execute, not just declare."""
        service.search_memory.return_value = SearchMemoryResponse(
            memories=[_entry("found")]
        )
        tool = FunctionTool(search)
        result = await tool.run_async(
            args={"query": "q"}, tool_context=MagicMock()
        )
        assert result["count"] == 1
        assert result["memories"][0]["content"] == "found"

    def test_llm_agent_accepts_the_bare_callables(self, tools):
        """ToolUnion smoke test: LlmAgent's pydantic layer takes the list
        as-is (Union[Callable, BaseTool, BaseToolset])."""
        from google.adk.agents.llm_agent import LlmAgent

        agent = LlmAgent(name="smoke", model="gemini-2.5-flash", tools=tools)
        assert len(agent.tools) == 3


# ─── Live: tool-level round-trip ─────────────────────────────────────────────


def _live_service(live):
    return FlairMemoryService(
        url=live.http_url,
        agent_id=live.agent_id,
        keyfile=live.keyfile_path,
        timeout=10.0,  # ephemeral Harper under test load — not a latency test
    )


@pytest.mark.live_flair
class TestToolsLive:
    async def test_store_search_list_round_trip(self, live_flair):
        app, user = "tools-rt", f"u-{uuid.uuid4().hex[:8]}"
        marker = f"tools-marker-{uuid.uuid4().hex[:8]}"
        service = _live_service(live_flair)
        store, search, listing = create_flair_tools(
            service, app_name=app, user_id=user
        )
        try:
            stored = await store(
                subject="Round Trip",
                description=f"the user prefers {marker} tea",
                tags=["preference", "beverage"],
                custom_metadata={"source": "tool-test"},
            )
            assert stored == {"status": "stored", "subject": "Round Trip"}

            found = await search(query=marker, limit=5)
            assert found["count"] >= 1, "stored memory not found by tool search"
            hit = next(
                (m for m in found["memories"] if marker in m["content"]), None
            )
            assert hit is not None, "marker memory missing from tool results"
            assert hit["subject"] == "Round Trip"
            assert hit["custom_metadata"]["tags"] == ["preference", "beverage"]
            assert hit["custom_metadata"]["source"] == "tool-test"
            assert hit["author"] == live_flair.agent_id

            listed = await listing(limit=20)
            assert listed["count"] >= 1
            assert any(marker in m["content"] for m in listed["memories"]), (
                "stored memory missing from tool list"
            )
        finally:
            await service.close()

    async def test_live_scope_isolation_between_tool_sets(self, live_flair):
        """A second user's tool set must not see the first user's memory."""
        app = "tools-iso"
        user_a, user_b = f"a-{uuid.uuid4().hex[:8]}", f"b-{uuid.uuid4().hex[:8]}"
        marker = f"iso-marker-{uuid.uuid4().hex[:8]}"
        service = _live_service(live_flair)
        store_a = create_flair_tools(service, app_name=app, user_id=user_a)[0]
        _, search_b, list_b = create_flair_tools(
            service, app_name=app, user_id=user_b
        )
        try:
            await store_a(subject="A only", description=f"secret {marker}")

            found_b = await search_b(query=marker)
            assert all(
                marker not in m["content"] for m in found_b["memories"]
            ), "user B's search tool surfaced user A's memory"

            listed_b = await list_b()
            assert all(
                marker not in m["content"] for m in listed_b["memories"]
            ), "user B's list tool surfaced user A's memory"
        finally:
            await service.close()
