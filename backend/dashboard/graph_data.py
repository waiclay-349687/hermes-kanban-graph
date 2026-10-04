from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

GRAPH_SCHEMA_VERSION = 2
_BODY_LIMIT = 2_000
_SUMMARY_LIMIT = 1_000
MAX_NODES = 5_000


def _value(task: Any, name: str, default: Any = None) -> Any:
    if isinstance(task, Mapping):
        return task.get(name, default)
    return getattr(task, name, default)


def _node(task: Any) -> dict[str, Any]:
    body = _value(task, "body")
    summary = _value(task, "latest_summary")
    return {
        "id": str(_value(task, "id")),
        "title": str(_value(task, "title", "") or ""),
        "body": body[:_BODY_LIMIT] if isinstance(body, str) else None,
        "status": str(_value(task, "status", "todo") or "todo"),
        "priority": int(_value(task, "priority", 0) or 0),
        "assignee": _value(task, "assignee"),
        "tenant": _value(task, "tenant"),
        "created_at": _value(task, "created_at"),
        "started_at": _value(task, "started_at"),
        "completed_at": _value(task, "completed_at"),
        "latest_summary": summary[:_SUMMARY_LIMIT] if isinstance(summary, str) else None,
        "hidden_parent_count": 0,
        "hidden_child_count": 0,
    }


def serialize_graph(
    tasks: Iterable[Any],
    edge_rows: Iterable[Mapping[str, Any]],
    *,
    board_slug: str,
    latest_event_id: int,
    known_ids: Optional[Iterable[str]] = None,
    archived_count: int = 0,
    max_nodes: int = MAX_NODES,
) -> dict[str, Any]:
    """Return a compact, read-only graph projection of Kanban task state.

    ``known_ids`` is every task id on the board (including ones the caller
    filtered out, e.g. archived). A link whose other endpoint is a known but
    hidden task is counted on the visible endpoint as ``hidden_parent_count`` /
    ``hidden_child_count`` so the UI never silently drops a dependency. Links to
    ids that do not exist at all (legacy/manual corruption) are ignored.
    """
    all_nodes = [_node(task) for task in tasks]
    truncated = len(all_nodes) > max_nodes
    nodes = all_nodes[:max_nodes]
    by_id = {node["id"]: node for node in nodes}
    known = set(known_ids) if known_ids is not None else set(by_id)
    edges = []
    seen: set[tuple[str, str]] = set()
    for row in edge_rows:
        source = str(row["parent_id"])
        target = str(row["child_id"])
        if source == target or (source, target) in seen:
            continue
        seen.add((source, target))
        source_node = by_id.get(source)
        target_node = by_id.get(target)
        if source_node is not None and target_node is not None:
            edges.append({"id": f"{source}->{target}", "source": source, "target": target})
        elif target_node is not None and source in known:
            target_node["hidden_parent_count"] += 1
        elif source_node is not None and target in known:
            source_node["hidden_child_count"] += 1

    return {
        "schema": GRAPH_SCHEMA_VERSION,
        "board": {"slug": board_slug, "latest_event_id": int(latest_event_id), "initialized": True},
        "nodes": nodes,
        "edges": edges,
        "archived_count": int(archived_count),
        "truncated": truncated,
    }


def empty_graph(board_slug: str) -> dict[str, Any]:
    """Projection for a board whose database has not been created yet."""
    return {
        "schema": GRAPH_SCHEMA_VERSION,
        "board": {"slug": board_slug, "latest_event_id": 0, "initialized": False},
        "nodes": [],
        "edges": [],
        "archived_count": 0,
        "truncated": False,
    }
