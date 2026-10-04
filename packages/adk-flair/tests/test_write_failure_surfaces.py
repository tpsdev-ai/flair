"""flair#1938 — a failed adk-flair memory write must surface, never read as stored.

Hermetic (default lane, ``-m "not live_flair"``): a real FlairMemoryService with
the same mocked HTTP client and signing the rest of the suite uses, exercising
``add_memory``'s partial-batch accounting and the ``store_memory`` tool's error
shape end-to-end through ``create_flair_tools``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

from adk_flair import create_flair_tools
from adk_flair.memory_service import FlairMemoryService


def _mem(record_id: str, text: str) -> MemoryEntry:
    return MemoryEntry(
        id=record_id,
        content=types.Content(role="user", parts=[types.Part(text=text)]),
    )


def _mock_response(status_code: int, reason: str = "") -> MagicMock:
    return MagicMock(
        status_code=status_code,
        reason_phrase=reason,
        headers={"content-type": "application/json"},
        text="{}",
    )


def _mock_http_client(base_url: str = "http://localhost:19926") -> MagicMock:
    """A mocked httpx client for the flair#1987 request path.

    ``_request`` now builds the final request ONCE with the client's
    ``build_request`` and sends THAT request. This double answers both:
    ``build_request`` returns a REAL request (via a scratch client) merged onto
    ``base_url``, so ``request.url.raw_path`` is the path httpx would send;
    ``send`` records the call on ``.request`` (keeping call_args/count
    assertions) and returns whatever ``.request`` is configured to return.
    """
    scratch = httpx.Client(base_url=base_url)
    client = MagicMock()
    client.request = AsyncMock()

    def build_request(method, url, **kwargs):
        req = scratch.build_request(method, url, **kwargs)
        req.extensions["test_method"] = method
        req.extensions["test_route"] = url
        req.extensions["test_json"] = kwargs.get("json")
        return req

    async def send(request, **kwargs):
        return await client.request(
            request.extensions["test_method"],
            request.extensions["test_route"],
            headers=dict(request.headers),
            json=request.extensions.get("test_json"),
        )

    client.build_request = build_request
    client.send = send
    return client


@pytest.fixture
def service():
    """A real FlairMemoryService with a mocked HTTP client and signing."""
    with patch(
        "adk_flair.memory_service._load_ed25519_key",
        return_value=MagicMock(),
    ), patch(
        "adk_flair.memory_service._sign_request",
        return_value="TPS-Ed25519 test-agent:0:0:AAAA",
    ), patch.dict("os.environ", {
        "FLAIR_AGENT_ID": "test-agent",
        "FLAIR_KEYFILE": "/fake/keyfile",
    }, clear=True):
        svc = FlairMemoryService(
            url="http://localhost:19926",
            agent_id="test-agent",
            keyfile="/fake/keyfile",
        )
        svc._client = _mock_http_client("http://localhost:19926")
        svc._url_logged = True
        yield svc


# ─── add_memory must raise on a failed write ────────────────────────────────


class TestAddMemoryRaisesOnWriteFailure:
    @pytest.mark.asyncio
    async def test_single_403_raises_with_written_zero_and_status(self, service):
        service._client.request.return_value = _mock_response(403, "Forbidden")

        with pytest.raises(RuntimeError) as excinfo:
            await service.add_memory(
                app_name="app", user_id="user",
                memories=[_mem("mem-403", "a fact")],
            )

        err = excinfo.value
        from adk_flair.memory_service import FlairRequestError, FlairWriteError

        assert isinstance(err, FlairWriteError)
        assert isinstance(err, FlairRequestError)  # existing except clauses keep working
        assert err.written == 0
        assert err.failed == [("mem-403", 403)]
        assert err.status_code == 403
        assert str(err) == "0 of 1 memories written; 1 refused (status 403)"

    @pytest.mark.asyncio
    async def test_single_500_raises_with_status_500(self, service):
        service._client.request.return_value = _mock_response(
            500, "Internal Server Error"
        )

        with pytest.raises(RuntimeError) as excinfo:
            await service.add_memory(
                app_name="app", user_id="user",
                memories=[_mem("mem-500", "a fact")],
            )

        err = excinfo.value
        assert type(err).__name__ == "FlairWriteError"
        assert err.written == 0
        assert err.failed == [("mem-500", 500)]
        assert err.status_code == 500
        assert str(err) == "0 of 1 memories written; 1 refused (status 500)"

    @pytest.mark.asyncio
    async def test_connection_error_raises_with_unknown_status(self, service):
        service._client.request.side_effect = httpx.ConnectError("connection refused")

        with pytest.raises(RuntimeError) as excinfo:
            await service.add_memory(
                app_name="app", user_id="user",
                memories=[_mem("mem-conn", "a fact")],
            )

        err = excinfo.value
        assert type(err).__name__ == "FlairWriteError"
        assert err.written == 0
        assert err.failed == [("mem-conn", "?")]
        assert err.status_code is None  # int | None — "?" lives only in message/failed
        assert "status ?" in str(err)

    @pytest.mark.asyncio
    async def test_mixed_batch_reports_written_and_names_failed_record(self, service):
        service._client.request.side_effect = [
            _mock_response(201),
            _mock_response(403, "Forbidden"),
            _mock_response(201),
        ]

        with pytest.raises(RuntimeError) as excinfo:
            await service.add_memory(
                app_name="app", user_id="user",
                memories=[_mem("m1", "one"), _mem("m2", "two"), _mem("m3", "three")],
            )

        err = excinfo.value
        assert type(err).__name__ == "FlairWriteError"
        assert err.written == 2
        assert err.failed == [("m2", 403)]  # the second record's id, status 403
        assert err.failed[0][0] == "m2"
        assert str(err) == "2 of 3 memories written; 1 refused (status 403)"
        assert service._client.request.call_count == 3

    @pytest.mark.asyncio
    async def test_skipped_entry_is_excluded_from_total_and_reported(self, service):
        # flair#1954: three entries, one text-less (skipped, never attempted),
        # one written, one refused → total counts the ATTEMPTED two.
        service._client.request.side_effect = [
            _mock_response(201),
            _mock_response(403, "Forbidden"),
        ]

        with pytest.raises(RuntimeError) as excinfo:
            await service.add_memory(
                app_name="app", user_id="user",
                memories=[_mem("m1", "one"), _mem("m2", ""), _mem("m3", "three")],
            )

        err = excinfo.value
        assert err.written == 1
        assert err.total == 2  # m2 (no text) is NOT attempted
        assert err.skipped == 1
        assert err.failed == [("m3", 403)]
        assert err.status_code == 403
        assert str(err) == (
            "1 of 2 memories written; 1 refused (status 403); 1 skipped (no text)"
        )
        assert service._client.request.call_count == 2  # the skipped entry is not written


# ─── store_memory tool surfaces the error, never "stored" ───────────────────


class TestStoreMemoryToolSurfacesWriteFailure:
    @pytest.mark.asyncio
    async def test_failed_write_returns_error_dict_never_stored(self, service):
        service._client.request.return_value = _mock_response(403, "Forbidden")
        store = create_flair_tools(service, app_name="app", user_id="user")[0]

        result = await store(subject="s", description="a fact")

        assert "error" in result
        assert result["written"] == 0
        assert result["failed"] == 1
        assert result.get("status") != "stored"
        assert "refused (status 403)" in result["error"]

    @pytest.mark.asyncio
    async def test_redirect_is_not_a_confirmed_write(self, service):
        # A 302 is below 400. Before the fix it read as success, and the tool
        # answered "stored" for a write Flair never acknowledged.
        service._client.request.return_value = _mock_response(302, "Found")
        store = create_flair_tools(service, app_name="app", user_id="user")[0]

        result = await store(subject="s", description="a fact")

        assert result.get("status") != "stored"
        assert result["written"] == 0
        assert result["failed"] == 1
        assert "status 302" in result["error"]

    @pytest.mark.asyncio
    async def test_successful_write_still_returns_stored(self, service):
        service._client.request.return_value = _mock_response(201)
        store = create_flair_tools(service, app_name="app", user_id="user")[0]

        result = await store(subject="Title", description="a fact")

        assert result == {"status": "stored", "subject": "Title"}

    @pytest.mark.asyncio
    async def test_error_dict_shape_is_unchanged_when_nothing_skipped(self, service):
        # flair#1954 item 3: the shape stays {"error", "written", "failed"} —
        # no "skipped" key unless it is non-zero.
        service._client.request.return_value = _mock_response(403, "Forbidden")
        store = create_flair_tools(service, app_name="app", user_id="user")[0]

        result = await store(subject="s", description="a fact")

        assert set(result.keys()) == {"error", "written", "failed"}
        assert result["written"] == 0
        assert result["failed"] == 1

    @pytest.mark.asyncio
    async def test_all_text_less_batch_raises_and_writes_nothing(self, service):
        empty = MemoryEntry(id="e1", content=types.Content(role="user", parts=[types.Part(text="")]))
        empty2 = MemoryEntry(id="e2", content=types.Content(role="user", parts=[]))
        with pytest.raises(ValueError) as info:
            await service.add_memory(app_name="app", user_id="user", memories=[empty, empty2])
        assert "nothing was written" in str(info.value)
        assert service._client.request.call_count == 0
