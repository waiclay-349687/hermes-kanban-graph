from __future__ import annotations

import importlib.util
import asyncio
import logging
import sqlite3
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from hermes_cli import kanban_db
from pydantic import BaseModel, ConfigDict, Field


def _load_graph_data():
    try:
        from . import graph_data
        return graph_data
    except (ImportError, ValueError):
        path = Path(__file__).with_name("graph_data.py")
        spec = importlib.util.spec_from_file_location("hermes_kanban_graph_data", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load graph_data.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


_graph_data = _load_graph_data()
serialize_graph = _graph_data.serialize_graph
empty_graph = _graph_data.empty_graph
router = APIRouter()
log = logging.getLogger(__name__)

# Fields of a task row that describe worker/process internals. They are never
# useful to the graph UI and must not leave the backend.
_PRIVATE_TASK_FIELDS = frozenset({"claim_lock", "claim_expires", "worker_pid", "worker_started_at"})


def _resolve_board(board: Optional[str]) -> Optional[str]:
    """Same contract as core ``_resolve_board``: ``None`` when omitted, so
    ``kanban_db_path(None)`` applies the ``HERMES_KANBAN_DB`` pin and fence rules;
    an explicit slug outranks the pin exactly where core lets it."""
    if board is None or board == "":
        return None
    try:
        normalized = kanban_db._normalize_board_slug(board)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not normalized:
        raise HTTPException(status_code=400, detail="board slug is required")
    if normalized != kanban_db.DEFAULT_BOARD and not kanban_db.board_exists(normalized):
        raise HTTPException(status_code=404, detail=f"board {normalized!r} does not exist")
    return normalized


def _board_label(slug: Optional[str]) -> str:
    return slug or kanban_db.get_current_board()


# --- strict read-only SQLite -------------------------------------------------

_READ_ACTIONS = frozenset(
    getattr(sqlite3, name)
    for name in ("SQLITE_SELECT", "SQLITE_READ", "SQLITE_FUNCTION", "SQLITE_RECURSIVE")
    if hasattr(sqlite3, name)
)


def _read_only_authorizer(action, _arg1, _arg2, _db_name, _trigger):
    """Defense in depth on top of ``mode=ro`` + ``query_only``: deny every
    statement that is not a plain read (DDL, DML, ATTACH, PRAGMA, ...)."""
    return sqlite3.SQLITE_OK if action in _READ_ACTIONS else sqlite3.SQLITE_DENY


def _connection(path: Path):
    if not path.exists():
        raise HTTPException(status_code=404, detail="Kanban database is not initialized for this board")
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA busy_timeout=2000")
        conn.execute("PRAGMA trusted_schema=OFF")
        set_authorizer = getattr(conn, "set_authorizer", None)
        if set_authorizer is not None:
            set_authorizer(_read_only_authorizer)
    except Exception:
        conn.close()
        raise
    return conn


def _public_task(task) -> dict[str, Any]:
    item = asdict(task)
    for key in _PRIVATE_TASK_FIELDS:
        item.pop(key, None)
    return item


def _task_payload(conn, task_id: str):
    task = kanban_db.get_task(conn, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"task {task_id} not found")
    item = _public_task(task)
    item["latest_summary"] = kanban_db.latest_summaries(conn, [task_id]).get(task_id)
    return item


# Heartbeats are one event per worker tick: noise for a human and unbounded growth
# for the drawer poll. Keep only the newest meaningful events.
EVENT_LIMIT = 50


def _recent_events(conn, task_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM task_events WHERE task_id = ? AND kind != 'heartbeat' ORDER BY id DESC LIMIT ?",
        (task_id, EVENT_LIMIT),
    ).fetchall()
    return [asdict(kanban_db.Event.from_row(row)) for row in reversed(rows)]


def _require_initialized(slug: Optional[str]) -> None:
    """Writes go through core ``_board_conn``, whose ``init_db`` would create a
    missing board database; the graph never creates one."""
    if not kanban_db.kanban_db_path(slug).exists():
        raise HTTPException(status_code=404, detail="Kanban database is not initialized for this board")


# --- writes delegate to the bundled Kanban dashboard backend ------------------
#
# Status and content edits must behave exactly like a drag/edit on the official
# board (worker termination when leaving ``running``, ``force`` completion,
# done/archived parent gating, descendant invalidation, lifecycle hooks). Rather
# than keeping a drifting copy of that logic, reuse the core handlers. When they
# cannot be found the edit is refused (503) instead of running divergent code.

_CORE_REQUIRED = ("_board_conn", "_require_task", "_patch_status", "_patch_title_body", "UpdateTaskBody")
_core_lock = threading.Lock()
_core_module: Optional[ModuleType] = None


def _core_dashboard_path() -> Path:
    return Path(kanban_db.__file__).resolve().parents[1] / "plugins" / "kanban" / "dashboard" / "plugin_api.py"


def _core_dashboard() -> ModuleType:
    global _core_module
    if _core_module is not None:
        return _core_module
    with _core_lock:
        if _core_module is not None:
            return _core_module
        path = _core_dashboard_path()
        module: Optional[ModuleType] = None
        for candidate in list(sys.modules.values()):
            file = getattr(candidate, "__file__", None)
            if file and all(hasattr(candidate, name) for name in _CORE_REQUIRED):
                try:
                    if Path(file).resolve() == path:
                        module = candidate
                        break
                except OSError:
                    continue
        if module is None:
            if not path.is_file():
                raise HTTPException(status_code=503, detail="Editing needs the bundled Kanban backend, which was not found")
            spec = importlib.util.spec_from_file_location("hermes_kanban_graph_core_kanban_api", path)
            if spec is None or spec.loader is None:
                raise HTTPException(status_code=503, detail="Could not load the bundled Kanban backend")
            module = importlib.util.module_from_spec(spec)
            # Pydantic resolves postponed annotations through sys.modules.
            sys.modules[spec.name] = module
            try:
                spec.loader.exec_module(module)
            except Exception as exc:  # pragma: no cover - depends on host install
                sys.modules.pop(spec.name, None)
                log.warning("kanban-graph: loading core kanban backend failed: %s", exc)
                raise HTTPException(status_code=503, detail="Could not load the bundled Kanban backend") from exc
        missing = [name for name in _CORE_REQUIRED if not hasattr(module, name)]
        if missing:
            raise HTTPException(
                status_code=503,
                detail=f"Editing is unavailable: the Kanban backend changed ({', '.join(missing)} missing)",
            )
        _core_module = module
        return module


class _StrictWritePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskContentPatch(_StrictWritePayload):
    title: Optional[str] = Field(default=None, max_length=10_000)
    body: Optional[str] = Field(default=None, max_length=200_000)
    status: Optional[Literal["triage", "todo", "ready", "blocked", "done", "archived"]] = None
    # Completion evidence: Kanban refuses ``done`` without a result/summary.
    summary: Optional[str] = Field(default=None, max_length=20_000)


class CommentCreate(_StrictWritePayload):
    body: str = Field(max_length=200_000)


# --- read routes --------------------------------------------------------------

@router.get("/health")
def health():
    return {"ok": True, "plugin": "kanban-graph"}


def _board_counts(slug: str) -> Optional[dict[str, Any]]:
    """Per-status task counts for the board switcher; ``None`` when unreadable."""
    try:
        path = kanban_db.kanban_db_path(slug)
        if not path.exists():
            return {"initialized": False, "total": 0, "by_status": {}}
        conn = _connection(path)
        try:
            rows = conn.execute("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").fetchall()
        finally:
            conn.close()
    except Exception as exc:  # unreadable/legacy DB must not break the switcher
        log.debug("kanban-graph: counting board %s failed: %s", slug, exc)
        return None
    by_status = {str(row["status"]): int(row["n"]) for row in rows}
    total = sum(n for status, n in by_status.items() if status != "archived")
    return {"initialized": True, "total": total, "by_status": by_status}


@router.get("/boards")
def boards(counts: bool = Query(True)):
    current = kanban_db.get_current_board()
    items = []
    for raw in kanban_db.list_boards(include_archived=True):
        slug = raw.get("slug")
        archived = bool(raw.get("archived"))
        item: dict[str, Any] = {
            "slug": slug,
            "name": raw.get("name"),
            "icon": raw.get("icon") or None,
            "color": raw.get("color") or None,
            "archived": archived,
            "is_current": slug == current,
        }
        if counts and not archived:
            stats = _board_counts(str(slug))
            if stats is not None:
                item.update(stats)
        items.append(item)
    return {"current": current, "boards": items}


@router.get("/workflow")
def workflow():
    """Core's manual move matrix, so the status menu offers only moves core accepts."""
    try:
        from hermes_cli import kanban_workflow
    except ImportError as exc:  # pragma: no cover - older hosts
        raise HTTPException(status_code=503, detail="Kanban workflow is unavailable") from exc
    return kanban_workflow.DEFAULT_WORKFLOW.to_dict()


@router.get("/graph")
def graph(
    board: Optional[str] = Query(None),
    include_archived: bool = Query(False),
):
    slug = _resolve_board(board)
    label = _board_label(slug)
    path = kanban_db.kanban_db_path(slug)
    if not path.exists():
        return empty_graph(label)
    return _read_graph(path, label, include_archived)


# --- all boards ---------------------------------------------------------------
#
# One read-only projection per open board, concatenated. Every node and edge is
# tagged with its ``board``; task ids are only unique within a board, so the UI
# keys cards by (board, id) and keeps calling the per-board routes with the
# task's own board. Archived boards and boards whose database was never created
# are skipped (nothing is opened, nothing is created). The per-board node cap
# still applies, and a global cap bounds the whole response; ``truncated`` says
# so honestly, per board and overall.

ALL_BOARDS = "*all*"  # not a valid slug: ``_BOARD_SLUG_RE`` rejects ``*``
MAX_ALL_NODES = 10_000


@router.get("/graph/all")
def graph_all(include_archived: bool = Query(False)):
    current = kanban_db.get_current_board()
    remaining = MAX_ALL_NODES
    boards_out: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    archived_count = 0
    total_count = 0
    truncated = False
    incomplete = False
    for raw in kanban_db.list_boards(include_archived=True):
        if raw.get("archived"):
            continue
        try:
            slug = kanban_db._normalize_board_slug(str(raw.get("slug") or ""))
        except ValueError:
            continue
        if not slug:
            continue
        entry: dict[str, Any] = {
            "slug": slug,
            "name": raw.get("name") or None,
            "icon": raw.get("icon") or None,
            "is_current": slug == current,
            "initialized": False,
            "latest_event_id": 0,
            "total": 0,
            "shown": 0,
            "archived_count": 0,
            "truncated": False,
        }
        boards_out.append(entry)
        path = kanban_db.kanban_db_path(slug)
        if not path.exists():
            continue
        try:
            if remaining <= 0:
                # Global budget spent: counts and event tail only, no task reads.
                counts = _read_counts(path, include_archived)
                entry.update(initialized=True, truncated=counts["total_count"] > 0, **{
                    "latest_event_id": counts["latest_event_id"],
                    "total": counts["total_count"],
                    "archived_count": counts["archived_count"],
                })
                archived_count += counts["archived_count"]
                total_count += counts["total_count"]
                truncated = truncated or counts["total_count"] > 0
                continue
            part = _read_graph(path, slug, include_archived, max_nodes=max(0, min(_graph_data.MAX_NODES, remaining)))
        except Exception as exc:  # one unreadable/legacy board must not hide the rest
            log.info("kanban-graph: reading board %s for the all-boards view failed: %s", slug, exc)
            entry["error"] = True
            incomplete = True
            continue
        shown = len(part["nodes"])
        remaining -= shown
        entry.update(
            initialized=True,
            latest_event_id=part["board"]["latest_event_id"],
            total=part["total_count"],
            shown=shown,
            archived_count=part["archived_count"],
            truncated=part["truncated"],
        )
        archived_count += part["archived_count"]
        total_count += part["total_count"]
        truncated = truncated or part["truncated"]
        nodes.extend({**node, "board": slug} for node in part["nodes"])
        edges.extend({**edge, "board": slug} for edge in part["edges"])
    return {
        "schema": _graph_data.GRAPH_SCHEMA_VERSION,
        "board": {
            "slug": ALL_BOARDS,
            "latest_event_id": 0,
            "initialized": any(item["initialized"] for item in boards_out),
        },
        "boards": boards_out,
        "nodes": nodes,
        "edges": edges,
        "archived_count": archived_count,
        "truncated": truncated,
        # Some board could not be read: totals are a lower bound and the
        # client must not treat missing tasks as deleted.
        "incomplete": incomplete,
        "total_count": total_count,
    }


def _read_counts(path: Path, include_archived: bool) -> dict[str, int]:
    conn = _connection(path)
    try:
        latest = conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM task_events").fetchone()["m"]
        archived = conn.execute("SELECT COUNT(*) AS n FROM tasks WHERE status = 'archived'").fetchone()["n"]
        everything = conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
    finally:
        conn.close()
    return {
        "latest_event_id": int(latest),
        "archived_count": 0 if include_archived else int(archived),
        "total_count": int(everything if include_archived else everything - archived),
    }


def _read_graph(path: Path, label: str, include_archived: bool, max_nodes: Optional[int] = None) -> dict[str, Any]:
    conn = _connection(path)
    try:
        # Event tail FIRST: a write between this and the reads below makes the
        # snapshot newer than its cursor (the socket replays one event, a
        # harmless refetch). Reading it last could hand out a cursor past a
        # change the snapshot does not contain, and the push would skip it.
        latest_event_id = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS m FROM task_events"
        ).fetchone()["m"]
        tasks = kanban_db.list_tasks(conn, include_archived=include_archived)
        summaries = kanban_db.latest_summaries(conn, [task.id for task in tasks])
        serialized_tasks = []
        for task in tasks:
            item = asdict(task)
            item["latest_summary"] = summaries.get(task.id)
            serialized_tasks.append(item)

        known_ids = [row["id"] for row in conn.execute("SELECT id FROM tasks").fetchall()]
        archived_count = 0
        if not include_archived:
            archived_count = conn.execute(
                "SELECT COUNT(*) AS n FROM tasks WHERE status = 'archived'"
            ).fetchone()["n"]
        edge_rows = conn.execute(
            "SELECT parent_id, child_id FROM task_links ORDER BY parent_id, child_id"
        ).fetchall()
        return serialize_graph(
            serialized_tasks,
            edge_rows,
            board_slug=label,
            latest_event_id=int(latest_event_id),
            known_ids=known_ids,
            archived_count=int(archived_count),
            **({} if max_nodes is None else {"max_nodes": max_nodes}),
        )
    finally:
        conn.close()


@router.get("/tasks/{task_id}")
def task_detail(task_id: str, board: Optional[str] = Query(None)):
    slug = _resolve_board(board)
    path = kanban_db.kanban_db_path(slug)
    conn = _connection(path)
    try:
        task = _task_payload(conn, task_id)
        links = {
            "parents": [
                row["parent_id"]
                for row in conn.execute(
                    "SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id",
                    (task_id,),
                ).fetchall()
            ],
            "children": [
                row["child_id"]
                for row in conn.execute(
                    "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
                    (task_id,),
                ).fetchall()
            ],
        }
        return {
            "task": task,
            "comments": [asdict(comment) for comment in kanban_db.list_comments(conn, task_id)],
            "events": _recent_events(conn, task_id),
            "links": links,
        }
    finally:
        conn.close()


# --- write routes -------------------------------------------------------------

@router.patch("/tasks/{task_id}")
def update_task_content(
    task_id: str,
    payload: TaskContentPatch,
    board: Optional[str] = Query(None),
):
    if payload.title is None and payload.body is None and payload.status is None:
        raise HTTPException(status_code=400, detail="title, body, or status is required")
    if payload.status is not None and (payload.title is not None or payload.body is not None):
        raise HTTPException(status_code=400, detail="change status separately from title or body")
    if payload.summary is not None and payload.status != "done":
        raise HTTPException(status_code=400, detail="summary is only accepted when completing a task")
    summary = payload.summary.strip() if payload.summary is not None else None
    title = payload.title.strip() if payload.title is not None else None
    if payload.title is not None and not title:
        raise HTTPException(status_code=400, detail="title cannot be empty")

    slug = _resolve_board(board)
    _require_initialized(slug)
    core = _core_dashboard()
    with core._board_conn(slug) as (resolved, conn):
        task = core._require_task(conn, task_id)
        if payload.status is not None:
            # complete_task writes ``result`` unconditionally; carry the stored one
            # so completing a reopened card does not erase it.
            result = getattr(task, "result", None) if payload.status == "done" else None
            change = core.UpdateTaskBody(status=payload.status, summary=summary or None, result=result)
            try:
                core._patch_status(conn, task_id, change, False)
            except ValueError as exc:  # e.g. EmptyCompletionError outside the core mapping
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        else:
            core._patch_title_body(conn, task_id, core.UpdateTaskBody(title=title, body=payload.body), resolved)
        return {"task": _task_payload(conn, task_id)}


@router.post("/tasks/{task_id}/comments")
def create_comment(
    task_id: str,
    payload: CommentCreate,
    board: Optional[str] = Query(None),
):
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="body is required")
    slug = _resolve_board(board)
    _require_initialized(slug)
    core = _core_dashboard()
    with core._board_conn(slug) as (_resolved, conn):
        core._require_task(conn, task_id)
        try:
            comment_id = kanban_db.add_comment(conn, task_id, author="desktop", body=body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "id": comment_id}


# --- live events ----------------------------------------------------------------
#
# ``ctx.socket`` only reaches this plugin's own namespace, so the graph cannot
# open core Kanban's ``/api/plugins/kanban/events``. This route serves the same
# ``{"events": [...], "cursor": n}`` frames and ``since`` semantics, but tails
# ``task_events`` through OUR strict read-only connection (``mode=ro`` +
# ``query_only`` + deny-all-writes authorizer): it can never create, initialize
# or migrate a board database, even if the file vanishes mid-stream (then the
# socket closes 1011 and the frontend falls back to polling).
#
# Auth is core's canonical WS gate (``_ws_upgrade_authorized``: ``?token=`` /
# ``?ticket=`` / ``?internal=``), consulted exactly once (tickets are
# single-use). Without it the socket closes 1011 (fail closed). The board is
# checked with the same rules as ``/graph`` before the gate; a close before
# ``accept`` is an HTTP 403 handshake rejection whatever the code.
#
# A ``{"events": [], "hello": true, "cursor": n}`` frame is sent on accept and
# then every ``KEEPALIVE_SECONDS``: idle boards produce no events, so the
# keepalive is what lets the frontend tell a live socket from a silently
# dropped one (the host's socket helper exposes no close signal).

_WS_POLICY_VIOLATION = 1008
_WS_INTERNAL_ERROR = 1011
EVENT_POLL_SECONDS = 0.3
KEEPALIVE_SECONDS = 20.0
_EVENT_BATCH = 200


def hello_frame(cursor: int) -> dict[str, Any]:
    return {"events": [], "hello": True, "cursor": cursor}


def _core_ws_gate() -> Optional[Callable[[WebSocket], bool]]:
    try:
        core = _core_dashboard()
    except HTTPException as exc:
        log.info("kanban-graph: live events unavailable: %s", exc.detail)
        return None
    gate = getattr(core, "_ws_upgrade_authorized", None)
    return gate if callable(gate) else None


def _since_param(raw: Optional[str]) -> Optional[int]:
    if raw is None or not str(raw).strip():
        return None
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return None


class _ReadOnlyEventTail:
    """One read-only connection per socket, used and closed on a single worker
    thread (sqlite connections are thread-affine)."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: Optional[sqlite3.Connection] = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kanban-graph-events")

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = _connection(self._path)  # raises if the file is gone
        return self._conn

    def _latest(self) -> int:
        row = self._db().execute("SELECT COALESCE(MAX(id), 0) AS m FROM task_events").fetchone()
        return int(row["m"]) if row else 0

    def _fetch(self, cursor: int) -> tuple[int, list[dict[str, Any]]]:
        if not self._path.exists():
            raise FileNotFoundError(str(self._path))
        rows = self._db().execute(
            "SELECT id, task_id, run_id, kind, created_at FROM task_events "
            "WHERE id > ? ORDER BY id ASC LIMIT ?",
            (cursor, _EVENT_BATCH),
        ).fetchall()
        events = [dict(row) for row in rows]
        return (int(rows[-1]["id"]) if rows else cursor), events

    def _close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    async def run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, *args)

    async def latest(self) -> int:
        return await self.run(self._latest)

    async def poll(self, cursor: int) -> tuple[int, list[dict[str, Any]]]:
        return await self.run(self._fetch, cursor)

    async def shutdown(self) -> None:
        try:
            await self.run(self._close)
        except Exception as exc:  # pragma: no cover - best effort
            log.warning("kanban-graph: event stream cleanup failed: %s", exc)
        finally:
            self._executor.shutdown(wait=True, cancel_futures=True)


@router.websocket("/events")
async def stream_events(ws: WebSocket):
    try:
        slug = _resolve_board(ws.query_params.get("board"))
        _require_initialized(slug)
    except HTTPException:
        await ws.close(code=_WS_POLICY_VIOLATION)
        return
    gate = _core_ws_gate()
    if gate is None:
        await ws.close(code=_WS_INTERNAL_ERROR)
        return
    if not gate(ws):
        await ws.close(code=_WS_POLICY_VIOLATION)
        return
    path = kanban_db.kanban_db_path(slug)
    tail = _ReadOnlyEventTail(path)
    try:
        since = _since_param(ws.query_params.get("since"))
        cursor = since if since is not None else await tail.latest()
        await ws.accept()
        await ws.send_json(hello_frame(cursor))
        loop = asyncio.get_running_loop()
        last_sent = loop.time()
        while True:
            try:
                message = await asyncio.wait_for(ws.receive(), timeout=EVENT_POLL_SECONDS)
                if message["type"] == "websocket.disconnect":
                    return
            except asyncio.TimeoutError:
                pass
            cursor, events = await tail.poll(cursor)
            if events:
                await ws.send_json({"events": events, "cursor": cursor})
                last_sent = loop.time()
            elif loop.time() - last_sent >= KEEPALIVE_SECONDS:
                await ws.send_json(hello_frame(cursor))
                last_sent = loop.time()
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        return
    except (HTTPException, FileNotFoundError, sqlite3.Error) as exc:
        log.info("kanban-graph: event stream for %r stopped: %s", slug, exc)
        try:
            await ws.close(code=_WS_INTERNAL_ERROR)
        except Exception:
            pass
    except Exception as exc:  # never crash the dashboard worker
        log.warning("kanban-graph: event stream error: %s", exc)
    finally:
        await tail.shutdown()


@router.post("/dispatch")
def dispatch(board: Optional[str] = Query(None)):
    """Nudge the dispatcher after an edit, like core's ``nudged()`` wrapper, so a
    card moved to Ready does not wait out the dispatcher tick. Every argument is
    passed explicitly: core's defaults are FastAPI ``Query`` objects."""
    slug = _resolve_board(board)
    _require_initialized(slug)
    core = _core_dashboard()
    handler = getattr(core, "dispatch", None)
    if handler is None:
        raise HTTPException(status_code=503, detail="The Kanban backend has no dispatch route")
    return handler(dry_run=False, max_n=8, board=slug)
