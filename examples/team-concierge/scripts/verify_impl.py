"""verify.sh implementation — the Team Concierge scenario's claims, executed.

Run through scripts/verify.sh (which documents the environment contract).

What is asserted (spec flair#1229 §6), each against a LIVE Flair instance:

  S1  Cross-harness, org-open: a decision recorded through the Concierge's
      record_decision helper is retrievable by a DIFFERENT agent identity via
      direct REST SemanticSearch, and the row is persistent + shared and
      carries the compound tag adk:concierge:<user>.
  S2  Private wall: personal context written through record_personal is NOT
      returned to the other identity (search absence + by-id GET 404), with a
      positive control proving the row is indexed and readable by its owner.
  S3  Tag scope: userA's retrieval through the Concierge connector excludes
      userB's personal rows, both directions (with positive controls).
  S4  Distillation hook: a scripted session's episodes are gathered by
      scope:"tagged" reflection for exactly one user, and (when the instance
      has a generative backend) a manual execute distill stages >=1
      MemoryCandidate whose scopeTag is EXACTLY adk:concierge:<user>.

Every negative assertion has a paired positive control in-script, so "not
found" can never mean "not indexed yet" or "the search never ran".

Mutation checks (documented per assertion below, runnable by hand):
  - Flip _PERSONAL_CLASS["visibility"] to "shared" in concierge/agent.py →
    S2 MUST fail (reader sees the personal row). Restore → passes.
  - Flip _DECISION_CLASS["visibility"] to "private" → S1 MUST fail.
  - Change the tag the S3 searches use to the other user's → the positive
    controls fail (proving the tag filter is what isolates).
  - Point S4's tag at userB → the episode-content assertion fails.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import sys
import time
import uuid
from types import SimpleNamespace

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

# The example's own agent module — verify drives the SAME helpers the LLM
# calls, not a parallel implementation.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from concierge.agent import (  # noqa: E402
    APP_NAME,
    persist_session_episodes,
    record_decision,
    record_personal,
)
from adk_flair import FlairMemoryService  # noqa: E402

SETTLE_BUDGET_S = float(os.environ.get("VERIFY_SETTLE_BUDGET_S", "30"))

# ─── Result accounting ───────────────────────────────────────────────────────

RESULTS: list[tuple[str, str, str]] = []  # (status, name, detail)


def record(status: str, name: str, detail: str = "") -> None:
    RESULTS.append((status, name, detail))
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def ensure(cond: bool, name: str, detail: str = "") -> None:
    record("PASS" if cond else "FAIL", name, detail)


# ─── Ed25519 REST client (TPS-Ed25519 auth, same scheme the connector uses) ──


class SignedClient:
    def __init__(self, base_url: str, agent_id: str, private_key: ed25519.Ed25519PrivateKey):
        self.base_url = base_url.rstrip("/")
        self.agent_id = agent_id
        self._key = private_key
        self._http = httpx.Client(base_url=self.base_url, timeout=10.0)

    def _auth(self, method: str, path: str) -> str:
        ts = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())
        payload = f"{self.agent_id}:{ts}:{nonce}:{method}:{path}".encode()
        sig = base64.b64encode(self._key.sign(payload)).decode()
        return f"TPS-Ed25519 {self.agent_id}:{ts}:{nonce}:{sig}"

    def request(
        self, method: str, path: str, body: dict | None = None, timeout: float | None = None
    ) -> httpx.Response:
        headers = {"Authorization": self._auth(method, path)}
        if body is not None:
            headers["Content-Type"] = "application/json"
        kwargs: dict = {"headers": headers, "json": body}
        if timeout is not None:
            kwargs["timeout"] = timeout
        return self._http.request(method, path, **kwargs)

    def search(self, q: str, tag: str | None = None, limit: int = 20) -> list[dict]:
        body: dict = {"agentId": self.agent_id, "q": q, "limit": limit}
        if tag:
            body["tag"] = tag
        resp = self.request("POST", "/SemanticSearch", body)
        if resp.status_code != 200:
            raise RuntimeError(f"SemanticSearch as {self.agent_id} → {resp.status_code}")
        return resp.json().get("results", [])

    def close(self) -> None:
        self._http.close()


def make_keypair() -> tuple[ed25519.Ed25519PrivateKey, str]:
    key = ed25519.Ed25519PrivateKey.generate()
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return key, base64.b64encode(pub).decode()


def key_to_pkcs8_b64(key: ed25519.Ed25519PrivateKey) -> str:
    der = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(der).decode()


def load_keyfile(path: str) -> ed25519.Ed25519PrivateKey:
    raw = open(os.path.expanduser(path), "rb").read()
    if len(raw) == 32:
        return ed25519.Ed25519PrivateKey.from_private_bytes(raw)
    text = raw.decode().strip()
    if "-----BEGIN" in text:
        key = serialization.load_pem_private_key(text.encode(), password=None)
    else:
        decoded = base64.b64decode(text)
        if len(decoded) == 32:
            return ed25519.Ed25519PrivateKey.from_private_bytes(decoded)
        key = serialization.load_der_private_key(decoded, password=None)
    assert isinstance(key, ed25519.Ed25519PrivateKey)
    return key


def register_agent(ops_url: str, admin_user: str, admin_pass: str, agent_id: str, pub_b64: str) -> None:
    auth = base64.b64encode(f"{admin_user}:{admin_pass}".encode()).decode()
    resp = httpx.post(
        ops_url,
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
        json={
            "operation": "insert",
            "database": "flair",
            "table": "Agent",
            "records": [{
                "id": agent_id,
                "name": agent_id,
                "role": "agent",
                "publicKey": pub_b64,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
            }],
        },
        timeout=15.0,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"agent registration for {agent_id} failed: HTTP {resp.status_code}")


# ─── Scripted Concierge session ──────────────────────────────────────────────
# A deterministic stand-in for the live ADK loop: it carries exactly what the
# helpers consume from a real ToolContext — the session's authenticated
# user_id (read-only) and the runner's memory service. The full write path
# (helper → fixed flags → connector add_memory → signed REST → server) is the
# real product code; only the LLM's decision to call the tool is scripted.


class ScriptedContext:
    def __init__(self, service: FlairMemoryService, user_id: str):
        self.user_id = user_id
        self._service = service

    def get_invocation_context(self):
        return SimpleNamespace(memory_service=self._service)


def content_hash_id(text: str) -> str:
    """The record id the connector derives for an entry without an explicit id."""
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def settle(predicate, budget_s: float = SETTLE_BUDGET_S) -> bool:
    """Poll until predicate() is truthy (returns True) or budget expires."""
    deadline = time.monotonic() + budget_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.5)
    return False


# ─── Main scenario ───────────────────────────────────────────────────────────


async def main() -> int:
    flair_url = os.environ.get("FLAIR_URL", "")
    if not flair_url:
        print("FLAIR_URL is required (see scripts/verify.sh)", file=sys.stderr)
        return 2

    run_id = uuid.uuid4().hex[:8]
    ops_url = os.environ.get("FLAIR_OPS_URL", "")
    admin_user = os.environ.get("FLAIR_ADMIN_USER", "")
    admin_pass = os.environ.get("FLAIR_ADMIN_PASS", "")

    # ── Identities: provided keyfiles, or auto-provisioned via the ops API ──
    if os.environ.get("CONCIERGE_KEYFILE") and os.environ.get("READER_KEYFILE"):
        concierge_id = os.environ.get("CONCIERGE_AGENT_ID", "concierge")
        reader_id = os.environ.get("READER_AGENT_ID", "")
        if not reader_id:
            print("READER_AGENT_ID is required with READER_KEYFILE", file=sys.stderr)
            return 2
        concierge_key = load_keyfile(os.environ["CONCIERGE_KEYFILE"])
        reader_key = load_keyfile(os.environ["READER_KEYFILE"])
        keyfile_path = os.path.expanduser(os.environ["CONCIERGE_KEYFILE"])
        cleanup_keyfile = None
    elif ops_url and admin_user and admin_pass:
        concierge_id = f"concierge-verify-{run_id}"
        reader_id = f"reader-verify-{run_id}"
        concierge_key, concierge_pub = make_keypair()
        reader_key, reader_pub = make_keypair()
        register_agent(ops_url, admin_user, admin_pass, concierge_id, concierge_pub)
        register_agent(ops_url, admin_user, admin_pass, reader_id, reader_pub)
        # The connector reads the concierge key from a file, like production.
        keyfile_path = os.path.join(
            os.environ.get("TMPDIR", "/tmp"), f"concierge-verify-{run_id}.key"
        )
        with open(keyfile_path, "w") as fh:
            fh.write(key_to_pkcs8_b64(concierge_key))
        os.chmod(keyfile_path, 0o600)
        cleanup_keyfile = keyfile_path
        print(f"[setup] provisioned verify identities: {concierge_id}, {reader_id}")
    else:
        print(
            "Provide either CONCIERGE_KEYFILE+READER_AGENT_ID+READER_KEYFILE, or "
            "FLAIR_OPS_URL+FLAIR_ADMIN_USER+FLAIR_ADMIN_PASS for auto-provisioning.",
            file=sys.stderr,
        )
        return 2

    test_start_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 60))

    service = FlairMemoryService(url=flair_url, agent_id=concierge_id, keyfile=keyfile_path)
    concierge_rest = SignedClient(flair_url, concierge_id, concierge_key)
    reader_rest = SignedClient(flair_url, reader_id, reader_key)

    user_a = f"alice-{run_id}"
    user_b = f"bob-{run_id}"
    tag_a = f"adk:{APP_NAME}:{user_a}"
    tag_b = f"adk:{APP_NAME}:{user_b}"
    ctx_a = ScriptedContext(service, user_a)
    ctx_b = ScriptedContext(service, user_b)

    token_d = f"quorum-{run_id}"
    token_p = f"lantern-{run_id}"
    token_pb = f"orchid-{run_id}"
    decision_text = (
        f"DECISION {token_d}: adopt the fastify adapter for the gateway because "
        f"it halves p99 latency in the spike."
    )
    personal_a_text = f"PERSONAL {token_p}: {user_a} prefers terse one-screen briefs."
    personal_b_text = f"PERSONAL {token_pb}: {user_b} prefers diagrams over prose."
    created_ids: list[str] = []

    print(f"\n=== Team Concierge verify — {flair_url} (run {run_id}) ===")
    print(f"    concierge identity: {concierge_id}; cross-identity reader: {reader_id}")
    print(f"    users: {user_a}, {user_b}\n")

    # ═════ S1 — decision: persistent + shared, readable cross-identity ══════
    # Mutation check: flip _DECISION_CLASS["visibility"] to "private" in
    # concierge/agent.py → the reader search below finds NOTHING and S1 fails.
    out = await record_decision(decision_text, ctx_a)  # scripted session, userA
    ensure(
        out.get("durability") == "persistent" and out.get("visibility") == "shared",
        "S1 helper reports fixed class persistent+shared",
        json.dumps({k: out[k] for k in ("durability", "visibility")}),
    )
    created_ids.append(content_hash_id(decision_text))

    hit_holder: dict = {}

    def _reader_sees_decision() -> bool:
        for hit in reader_rest.search(token_d):
            if token_d in (hit.get("content") or ""):
                hit_holder.update(hit)
                return True
        return False

    found = settle(_reader_sees_decision)
    ensure(found, f"S1 decision retrievable by DIFFERENT identity ({reader_id}) via REST SemanticSearch")
    if found:
        ensure(hit_holder.get("visibility") == "shared", "S1 row visibility == shared",
               f"got {hit_holder.get('visibility')!r}")
        ensure(hit_holder.get("durability") == "persistent", "S1 row durability == persistent",
               f"got {hit_holder.get('durability')!r}")
        ensure(tag_a in (hit_holder.get("tags") or []),
               f"S1 row carries compound tag {tag_a}",
               f"tags={hit_holder.get('tags')}")

    # ═════ S2 — personal: private wall against the other identity ═══════════
    # Mutation check: flip _PERSONAL_CLASS["visibility"] to "shared" →
    # the helper-report, search-absence, by-id-denied, and stored-flags
    # assertions below ALL fail. Restore → passes. (The #1222-class
    # regression detector.)
    out = await record_personal(personal_a_text, ctx_a)
    ensure(
        out.get("durability") == "standard" and out.get("visibility") == "private",
        "S2 helper reports fixed class standard+private",
        json.dumps({k: out[k] for k in ("durability", "visibility")}),
    )
    personal_a_id = content_hash_id(personal_a_text)
    created_ids.append(personal_a_id)

    # Positive control FIRST: the owner (concierge identity) can see the row —
    # so the absence assertions below can never pass because of slow indexing.
    indexed = settle(
        lambda: any(token_p in (h.get("content") or "") for h in concierge_rest.search(token_p))
    )
    ensure(indexed, "S2 positive control: owner identity sees the personal row (it IS indexed)")

    reader_hits = reader_rest.search(token_p)
    leaked = [h for h in reader_hits if token_p in (h.get("content") or "")]
    ensure(
        not leaked,
        f"S2 private wall: {reader_id}'s search does NOT return the personal row",
        f"reader got {len(reader_hits)} hits for the token query, "
        f"{len(leaked)} containing the personal token",
    )
    # Denied by-id read: the auth-middleware guard 403s a cross-agent private
    # read (resources/auth-middleware.ts); the resource layer behind it 404s.
    # Either status is a wall — what must never happen is a 200 with content.
    resp = reader_rest.request("GET", f"/Memory/{personal_a_id}")
    ensure(
        resp.status_code in (403, 404),
        "S2 private wall: reader by-id GET is denied (403/404, never content)",
        f"got HTTP {resp.status_code}",
    )
    resp = concierge_rest.request("GET", f"/Memory/{personal_a_id}")
    row = resp.json() if resp.status_code == 200 else {}
    ensure(
        resp.status_code == 200
        and row.get("visibility") == "private"
        and row.get("durability") == "standard",
        "S2 stored row is standard+private (owner read confirms persisted flags)",
        f"HTTP {resp.status_code}, visibility={row.get('visibility')!r}, durability={row.get('durability')!r}",
    )

    # ═════ S3 — tag scope between users, both directions ════════════════════
    # Mutation check: swap tag_a/tag_b in the two exclusion searches below —
    # each then FINDS the other user's row through the connector, failing the
    # assertion (proving the compound tag is what isolates, and that this is
    # an application filter — see the README limitation paragraph).
    await record_personal(personal_b_text, ctx_b)
    created_ids.append(content_hash_id(personal_b_text))

    async def _connector_hits(user_id: str, query: str) -> list[str]:
        res = await service.search_memory(app_name=APP_NAME, user_id=user_id, query=query)
        texts = []
        for m in res.memories:
            if m.content and m.content.parts:
                texts.append(" ".join(p.text or "" for p in m.content.parts))
        return texts

    async def _settle_async(coro_factory, budget_s: float = SETTLE_BUDGET_S) -> bool:
        deadline = time.monotonic() + budget_s
        while time.monotonic() < deadline:
            if await coro_factory():
                return True
            await asyncio.sleep(0.5)
        return False

    # Positive controls: each user retrieves their OWN personal row.
    ok_a = await _settle_async(lambda: _contains(_connector_hits(user_a, token_p), token_p))
    ensure(ok_a, f"S3 positive control: {user_a} retrieves their own personal row via the Concierge")
    ok_b = await _settle_async(lambda: _contains(_connector_hits(user_b, token_pb), token_pb))
    ensure(ok_b, f"S3 positive control: {user_b} retrieves their own personal row via the Concierge")

    cross_ab = await _connector_hits(user_a, token_pb)
    ensure(
        not any(token_pb in t for t in cross_ab),
        f"S3 {user_a}'s Concierge retrieval excludes {user_b}'s personal row",
        f"{len(cross_ab)} hits, none containing {token_pb}",
    )
    cross_ba = await _connector_hits(user_b, token_p)
    ensure(
        not any(token_p in t for t in cross_ba),
        f"S3 {user_b}'s Concierge retrieval excludes {user_a}'s personal row",
        f"{len(cross_ba)} hits, none containing {token_p}",
    )

    # ═════ S4 — distillation hook: tagged gather + scopeTag on candidates ═══
    # Mutation check: change `tag` below to tag_b → the "episode content
    # gathered" assertion fails (userA's episodes are not under userB's tag);
    # under execute mode the scopeTag equality assertion fails the same way.
    episode_token = f"beacon-{run_id}"
    session_id = f"verify-session-{run_id}"
    events = [
        SimpleNamespace(
            id=f"ev-{i}-{run_id}",
            author=author,
            content=SimpleNamespace(parts=[SimpleNamespace(text=text)]),
        )
        for i, (author, text) in enumerate([
            (user_a, f"We spiked both gateways this week, {episode_token} run."),
            ("team_concierge", "Noted. What did the p99 comparison show?"),
            (user_a, f"Fastify halved p99; we should adopt it — {episode_token}."),
        ])
    ]
    wrote = await persist_session_episodes(
        service, app_name=APP_NAME, user_id=user_a, session_id=session_id, events=events
    )
    ensure(wrote == 3, "S4 scripted session persisted 3 episode rows", f"wrote={wrote}")
    created_ids += [f"{APP_NAME}:{user_a}:{session_id}:ev-{i}-{run_id}" for i in range(3)]

    # Episodes are standard+private explicit — confirm one persisted row.
    resp = concierge_rest.request("GET", f"/Memory/{APP_NAME}:{user_a}:{session_id}:ev-0-{run_id}")
    row = resp.json() if resp.status_code == 200 else {}
    ensure(
        row.get("visibility") == "private" and row.get("durability") == "standard",
        "S4 episode rows are standard+private (explicit at the write-site)",
        f"visibility={row.get('visibility')!r}, durability={row.get('durability')!r}",
    )

    # 4a — tagged gather is per-user (the #1205b cross-user-bleed boundary).
    def _gather() -> dict | None:
        resp = concierge_rest.request(
            "POST", "/ReflectMemories",
            {"agentId": concierge_id, "scope": "tagged", "tag": tag_a, "since": test_start_iso},
        )
        if resp.status_code != 200:
            return None
        body = resp.json()
        texts = [m.get("content") or "" for m in body.get("memories", [])]
        return body if any(episode_token in t for t in texts) else None

    gather_holder: dict = {}

    def _gather_settled() -> bool:
        body = _gather()
        if body:
            gather_holder.update(body)
            return True
        return False

    ensure(settle(_gather_settled), "S4a tagged reflect gather includes the scripted episodes")
    if gather_holder:
        mems = gather_holder.get("memories", [])
        ensure(
            all(tag_a in (m.get("tags") or []) for m in mems),
            f"S4a every gathered memory carries {tag_a} (no cross-user bleed into distillation)",
            f"{len(mems)} memories gathered",
        )
        ensure(
            not any(token_pb in (m.get("content") or "") for m in mems),
            f"S4a gathered set contains nothing of {user_b}'s",
        )

    # 4b — execute distill stages MemoryCandidate rows stamped with scopeTag.
    # Server-side generation can take minutes on a cold model — generous
    # client timeout, distinct from the normal REST budget. A COLD backend can
    # also abort Harper's open transaction (HTTP 422 "Transaction was aborted
    # after exceeding the maximum open-transaction time") while the model
    # loads; the first attempt warms it, so retry exactly once on 422.
    def _execute_distill() -> httpx.Response:
        return concierge_rest.request(
            "POST", "/ReflectMemories",
            {"agentId": concierge_id, "scope": "tagged", "tag": tag_a,
             "since": test_start_iso, "execute": True},
            timeout=float(os.environ.get("VERIFY_DISTILL_TIMEOUT_S", "300")),
        )

    resp = _execute_distill()
    if resp.status_code == 422:
        print("[S4b] transaction-abort on cold backend (HTTP 422) — retrying once, model now warm")
        resp = _execute_distill()
    if resp.status_code == 200:
        body = resp.json()
        cands = body.get("candidates", [])
        ensure(len(cands) >= 1, "S4b manual execute distill staged >=1 MemoryCandidate",
               f"count={len(cands)}, model={body.get('model')}")
        ensure(
            bool(cands) and all(c.get("scopeTag") == tag_a for c in cands),
            f"S4b every staged candidate has scopeTag == {tag_a} (exact match, not just presence)",
            f"scopeTags={[c.get('scopeTag') for c in cands]}",
        )
    elif resp.status_code == 503:
        # No generative backend on this instance. This assertion CANNOT fire
        # here — say so loudly rather than letting it look like a pass
        # (an unrun check must not look like a pass). REQUIRE_DISTILL=1
        # makes this a hard failure for instances that must have the backend.
        detail = (
            "instance has no generative backend (HTTP 503) — configure Harper's "
            "models: block (see flair docs/rem.md) and re-run; set REQUIRE_DISTILL=1 "
            "to make this a failure"
        )
        if os.environ.get("REQUIRE_DISTILL") == "1":
            record("FAIL", "S4b execute distill (REQUIRE_DISTILL=1)", detail)
        else:
            record("SKIP", "S4b execute distill + scopeTag assertion", detail)
    else:
        record("FAIL", "S4b execute distill", f"HTTP {resp.status_code}: {resp.text[:200]}")

    # ── Cleanup (best-effort; VERIFY_KEEP_ROWS=1 to skip) ───────────────────
    if os.environ.get("VERIFY_KEEP_ROWS") != "1":
        deleted = 0
        for mem_id in created_ids:
            r = concierge_rest.request("DELETE", f"/Memory/{mem_id}")
            deleted += 1 if r.status_code < 400 else 0
        print(f"\n[cleanup] deleted {deleted}/{len(created_ids)} verify rows "
              f"(staged MemoryCandidate rows, if any, are left for the reviewer flow)")
    if cleanup_keyfile:
        try:
            os.unlink(cleanup_keyfile)
        except OSError:
            pass

    await service.close()
    concierge_rest.close()
    reader_rest.close()

    # ── Summary ─────────────────────────────────────────────────────────────
    passed = sum(1 for s, _, _ in RESULTS if s == "PASS")
    failed = sum(1 for s, _, _ in RESULTS if s == "FAIL")
    skipped = sum(1 for s, _, _ in RESULTS if s == "SKIP")
    print(f"\n=== verify summary: {passed} passed, {failed} failed, {skipped} skipped ===")
    if skipped:
        for s, name, detail in RESULTS:
            if s == "SKIP":
                print(f"    SKIPPED (not a pass): {name} — {detail}")
    return 1 if failed else 0


async def _contains(coro, token: str) -> bool:
    return any(token in t for t in await coro)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
