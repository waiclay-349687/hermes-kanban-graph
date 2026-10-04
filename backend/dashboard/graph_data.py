from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any, Iterable, Mapping

_BODY_LIMIT = 2_000
_SUMMARY_LIMIT = 1_000


def _value(task: Any, name: str, default: Any = None) -> Any:
    if isinstance(task, Mapping):
        return task.get(name, default)
    return getattr(task, name, default)


def _node(task: Any) -> dict[str, Any]:
    body = _value(task, "body")
    summary = _value(task, "latest_summary")
    return {
        "id": str(_value(task, "id")),
        "title": str(_value(task, "title", "")),
        "body": body[:_BODY_LIMIT] if isinstance(body, str) else None,
        "status": str(_value(task, "status", "todo")),
        "priority": int(_value(task, "priority", 0) or 0),
        "assignee": _value(task, "assignee"),
        "tenant": _value(task, "tenant"),
        "created_at": _value(task, "created_at"),
        "started_at": _value(task, "started_at"),
        "completed_at": _value(task, "completed_at"),
        "latest_summary": summary[:_SUMMARY_LIMIT] if isinstance(summary, str) else None,
    }


def serialize_graph(
    tasks: Iterable[Any],
    edge_rows: Iterable[Mapping[str, Any]],
    *,
    board_slug: str,
    latest_event_id: int,
) -> dict[str, Any]:
    """Return a compact, read-only graph projection of Kanban task state."""
    nodes = [_node(task) for task in tasks]
    visible = {node["id"] for node in nodes}
    edges = []
    for row in edge_rows:
        source = str(row["parent_id"])
        target = str(row["child_id"])
        if source not in visible or target not in visible:
            continue
        edges.append({"id": f"{source}->{target}", "source": source, "target": target})

    return {
        "board": {"slug": board_slug, "latest_event_id": int(latest_event_id)},
        "nodes": nodes,
        "edges": edges,
    }
