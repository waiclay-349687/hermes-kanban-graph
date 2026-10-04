from __future__ import annotations

import importlib.util
import json
import logging
import os
import sqlite3
import time
from dataclasses import asdict
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from hermes_cli import kanban_db
from pydantic import BaseModel, ConfigDict, Field


def _load_serializer():
    try:
        from .graph_data import serialize_graph
        return serialize_graph
    except (ImportError, ValueError):
        path = Path(__file__).with_name("graph_data.py")
        spec = importlib.util.spec_from_file_location("hermes_kanban_graph_data", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load graph_data.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.serialize_graph


serialize_graph = _load_serializer()
router = APIRouter()
log = logging.getLogger(__name__)


def _resolve_board(board: Optional[str]) -> str:
    if board is None or board == "":
        return kanban_db.get_current_board()
    try:
        normalized = kanban_db._normalize_board_slug(board)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not normalized:
        raise HTTPException(status_code=400, detail="board slug is required")
    if normalized != kanban_db.DEFAULT_BOARD and not kanban_db.board_exists(normalized):
        raise HTTPException(status_code=404, detail=f"board {normalized!r} does not exist")
    if os.environ.get("HERMES_KANBAN_DB", "").strip() and normalized != kanban_db.get_current_board():
        raise HTTPException(status_code=409, detail="Kanban database is pinned to the current board")
    return normalized


def _connection(path: Path):
    if not path.exists():
        raise HTTPException(status_code=404, detail="Kanban database is not initialized for this board")
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA busy_timeout=2000")
        conn.execute("PRAGMA trusted_schema=OFF")
    except Exception:
        conn.close()
        raise
    return conn


def _write_connection(path: Path):
    if not path.exists():
        raise HTTPException(status_code=404, detail="Kanban database is not initialized for this board")
    conn = sqlite3.connect(
        f"{path.resolve().as_uri()}?mode=rw",
        uri=True,
        timeout=5.0,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=2000")
        conn.execute("PRAGMA trusted_schema=OFF")
    except Exception:
        conn.close()
        raise
    return conn


def _task_payload(conn, task_id: str):
    task = kanban_db.get_task(conn, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"task {task_id} not found")
    item = asdict(task)
    item["latest_summary"] = kanban_db.latest_summaries(conn, [task_id]).get(task_id)
    return item


class _StrictWritePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskContentPatch(_StrictWritePayload):
    title: Optional[str] = Field(default=None, max_length=10_000)
    body: Optional[str] = Field(default=None, max_length=200_000)
    status: Optional[Literal["triage", "todo", "ready", "blocked", "done", "archived"]] = None


class CommentCreate(_StrictWritePayload):
    body: str = Field(max_length=200_000)


def _unfinished_parents(conn, task_id: str):
    return conn.execute(
        "SELECT t.title FROM tasks t "
        "JOIN task_links l ON l.parent_id = t.id "
        "WHERE l.child_id = ? AND t.status != 'done' "
        "ORDER BY t.title",
        (task_id,),
    ).fetchall()


def _set_status_direct(conn, task_id: str, new_status: str) -> bool:
    """Mirror the official Kanban dashboard's direct status transition.

    Structured transitions such as complete, block, unblock, and archive use
    their public kanban_db helpers. This handles the remaining operator-owned
    lanes while preserving active-run and dependency invariants.
    """
    with kanban_db.write_txn(conn):
        previous = conn.execute(
            "SELECT status, current_run_id FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        if previous is None:
            return False
        if new_status == "ready" and _unfinished_parents(conn, task_id):
            return False

        was_running = previous["status"] == "running"
        reopened_parent = (
            previous["status"] in {"done", "archived"}
            and new_status not in {"done", "archived"}
        )
        updated = conn.execute(
            "UPDATE tasks SET status = ?, "
            "claim_lock = CASE WHEN ? = 'running' THEN claim_lock ELSE NULL END, "
            "claim_expires = CASE WHEN ? = 'running' THEN claim_expires ELSE NULL END, "
            "worker_pid = CASE WHEN ? = 'running' THEN worker_pid ELSE NULL END "
            "WHERE id = ?",
            (new_status, new_status, new_status, new_status, task_id),
        )
        if updated.rowcount != 1:
            return False

        run_id = None
        if was_running and new_status != "running" and previous["current_run_id"]:
            run_id = kanban_db._end_run(
                conn,
                task_id,
                outcome="reclaimed",
                status="reclaimed",
                summary=f"status changed to {new_status} (kanban-graph/direct)",
            )
        conn.execute(
            "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
            "VALUES (?, ?, 'status', ?, ?)",
            (task_id, run_id, json.dumps({"status": new_status}), int(time.time())),
        )

        if reopened_parent:
            for row in conn.execute(
                "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
                (task_id,),
            ).fetchall():
                child_id = row["child_id"]
                demoted = conn.execute(
                    "UPDATE tasks SET status = 'todo' WHERE id = ? AND status = 'ready'",
                    (child_id,),
                )
                if demoted.rowcount == 1:
                    conn.execute(
                        "INSERT INTO task_events (task_id, kind, payload, created_at) "
                        "VALUES (?, 'status', ?, ?)",
                        (
                            child_id,
                            json.dumps({
                                "status": "todo",
                                "reason": "parent_reopened",
                                "parent": task_id,
                            }),
                            int(time.time()),
                        ),
                    )
    if new_status in {"done", "ready"}:
        kanban_db.recompute_ready(conn)
    return True


def _change_status(conn, task_id: str, new_status: str) -> bool:
    current = kanban_db.get_task(conn, task_id)
    if current is None:
        return False
    if new_status == "done":
        return kanban_db.complete_task(conn, task_id)
    if new_status == "blocked":
        return kanban_db.block_task(conn, task_id)
    if new_status == "ready" and current.status in {"blocked", "scheduled"}:
        return kanban_db.unblock_task(conn, task_id)
    if new_status == "archived":
        return kanban_db.archive_task(conn, task_id)
    return _set_status_direct(conn, task_id, new_status)


@router.get("/health")
def health():
    return {"ok": True, "plugin": "kanban-graph"}


@router.get("/boards")
def boards():
    current = kanban_db.get_current_board()
    pinned = bool(os.environ.get("HERMES_KANBAN_DB", "").strip())
    items = []
    for raw in kanban_db.list_boards(include_archived=True):
        slug = raw.get("slug")
        if pinned and slug != current:
            continue
        items.append({
            "slug": slug,
            "name": raw.get("name"),
            "archived": bool(raw.get("archived")),
            "is_current": slug == current,
        })
    return {"current": current, "boards": items}


@router.get("/graph")
def graph(
    board: Optional[str] = Query(None),
    include_archived: bool = Query(False),
):
    slug = _resolve_board(board)
    path = kanban_db.kanban_db_path(slug)
    conn = _connection(path)
    try:
        tasks = kanban_db.list_tasks(conn, include_archived=include_archived)
        summaries = kanban_db.latest_summaries(conn, [task.id for task in tasks])
        serialized_tasks = []
        for task in tasks:
            item = asdict(task)
            item["latest_summary"] = summaries.get(task.id)
            serialized_tasks.append(item)

        edge_rows = conn.execute(
            "SELECT parent_id, child_id FROM task_links ORDER BY parent_id, child_id"
        ).fetchall()
        latest_event_id = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS m FROM task_events"
        ).fetchone()["m"]
        return serialize_graph(
            serialized_tasks,
            edge_rows,
            board_slug=slug,
            latest_event_id=int(latest_event_id),
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
            "events": [asdict(event) for event in kanban_db.list_events(conn, task_id)],
            "links": links,
        }
    finally:
        conn.close()


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
    title = payload.title.strip() if payload.title is not None else None
    if payload.title is not None and not title:
        raise HTTPException(status_code=400, detail="title cannot be empty")

    slug = _resolve_board(board)
    path = kanban_db.kanban_db_path(slug)
    conn = _write_connection(path)
    try:
        task = _task_payload(conn, task_id)
        if payload.status is not None:
            if not _change_status(conn, task_id, payload.status):
                if payload.status == "ready":
                    parents = _unfinished_parents(conn, task_id)
                    if parents:
                        names = ", ".join(row["title"] for row in parents)
                        raise HTTPException(
                            status_code=409,
                            detail=f"Parent tasks must be completed first: {names}",
                        )
                raise HTTPException(
                    status_code=409,
                    detail=f"Cannot move a {task['status']} task to {payload.status}",
                )
        else:
            with kanban_db.write_txn(conn):
                if title is not None and payload.body is not None:
                    conn.execute("UPDATE tasks SET title = ?, body = ? WHERE id = ?", (title, payload.body, task_id))
                elif title is not None:
                    conn.execute("UPDATE tasks SET title = ? WHERE id = ?", (title, task_id))
                else:
                    conn.execute("UPDATE tasks SET body = ? WHERE id = ?", (payload.body, task_id))
                conn.execute(
                    "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'edited', NULL, ?)",
                    (task_id, int(time.time())),
                )
        return {"task": _task_payload(conn, task_id)}
    finally:
        conn.close()


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
    path = kanban_db.kanban_db_path(slug)
    conn = _write_connection(path)
    try:
        if kanban_db.get_task(conn, task_id) is None:
            raise HTTPException(status_code=404, detail=f"task {task_id} not found")
        try:
            comment_id = kanban_db.add_comment(conn, task_id, author="desktop", body=body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "id": comment_id}
    finally:
        conn.close()
