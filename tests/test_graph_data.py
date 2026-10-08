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

    assert payload['board'] == {'slug': 'default', 'latest_event_id': 9, 'initialized': True}
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


def test_links_to_hidden_tasks_are_counted_not_dropped_silently():
    tasks = [Task('child', 'Child', None, 'todo', 0, None, None, 1), Task('parent', 'Parent', None, 'ready', 0, None, None, 2)]
    rows = [
        {'parent_id': 'archived-parent', 'child_id': 'child'},
        {'parent_id': 'parent', 'child_id': 'archived-child'},
        {'parent_id': 'ghost', 'child_id': 'child'},
        {'parent_id': 'parent', 'child_id': 'child'},
        {'parent_id': 'parent', 'child_id': 'child'},
        {'parent_id': 'child', 'child_id': 'child'},
    ]
    payload = serialize_graph(
        tasks, rows, board_slug='b', latest_event_id=1,
        known_ids=['child', 'parent', 'archived-parent', 'archived-child'], archived_count=2,
    )
    nodes = {node['id']: node for node in payload['nodes']}
    assert nodes['child']['hidden_parent_count'] == 1
    assert nodes['parent']['hidden_child_count'] == 1
    assert payload['edges'] == [{'id': 'parent->child', 'source': 'parent', 'target': 'child'}]
    assert payload['archived_count'] == 2


def test_node_cap_marks_payload_truncated():
    tasks = [Task(f't{i}', 'T', None, 'todo', 0, None, None, i) for i in range(5)]
    payload = serialize_graph(tasks, [], board_slug='b', latest_event_id=0, max_nodes=3)
    assert len(payload['nodes']) == 3
    assert payload['truncated'] is True
    assert payload['total_count'] == 5


def test_links_to_truncated_tasks_are_counted_apart_from_archived_ones():
    tasks = [Task(f't{i}', 'T', None, 'todo', 0, None, None, i) for i in range(4)]
    rows = [
        {'parent_id': 't3', 'child_id': 't0'},
        {'parent_id': 'archived', 'child_id': 't0'},
        {'parent_id': 't1', 'child_id': 't2'},
    ]
    payload = serialize_graph(
        tasks, rows, board_slug='b', latest_event_id=0,
        known_ids=['t0', 't1', 't2', 't3', 'archived'], archived_count=1, max_nodes=2,
    )
    nodes = {node['id']: node for node in payload['nodes']}
    assert nodes['t0']['truncated_parent_count'] == 1
    assert nodes['t0']['hidden_parent_count'] == 1
    assert nodes['t1']['truncated_child_count'] == 1
    assert nodes['t1']['hidden_child_count'] == 0
