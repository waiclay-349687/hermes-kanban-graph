from dataclasses import dataclass

from backend.dashboard.graph_data import serialize_graph


@dataclass
class Task:
    id: str
    title: str
    body: str | None
    status: str
    priority: int
    assignee: str | None
    tenant: str | None
    created_at: int
    started_at: int | None = None
    completed_at: int | None = None
    latest_summary: str | None = None


def test_serialize_graph_returns_nodes_edges_and_metadata():
    tasks = [
        Task('parent', 'Parent', 'body', 'ready', 0, None, None, 10),
        Task('child', 'Child', None, 'todo', 2, 'default', 'wiki', 11),
        Task('isolated', 'Isolated', None, 'blocked', 3, None, None, 12),
    ]
    rows = [
        {'parent_id': 'parent', 'child_id': 'child'},
        {'parent_id': 'missing', 'child_id': 'child'},
    ]

    payload = serialize_graph(tasks, rows, board_slug='default', latest_event_id=9)

    assert payload['board'] == {'slug': 'default', 'latest_event_id': 9}
    assert [node['id'] for node in payload['nodes']] == ['parent', 'child', 'isolated']
    assert payload['nodes'][1]['assignee'] == 'default'
    assert payload['nodes'][1]['tenant'] == 'wiki'
    assert payload['edges'] == [
        {'id': 'parent->child', 'source': 'parent', 'target': 'child'}
    ]


def test_serialize_graph_truncates_large_descriptions_and_summaries():
    task = Task('t1', 'Title', 'x' * 5000, 'ready', 0, None, None, 1)
    task.latest_summary = 'y' * 5000

    payload = serialize_graph([task], [], board_slug='default', latest_event_id=0)
    node = payload['nodes'][0]

    assert len(node['body']) == 2000
    assert len(node['latest_summary']) == 1000
