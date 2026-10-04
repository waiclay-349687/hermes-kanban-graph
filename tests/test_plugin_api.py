from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.dashboard import plugin_api


def test_write_payloads_allow_status_but_reject_other_task_fields():
    payload = plugin_api.TaskContentPatch.model_validate({'status': 'ready'})
    assert payload.status == 'ready'
    for system_status in ('scheduled', 'running', 'review'):
        with pytest.raises(ValidationError):
            plugin_api.TaskContentPatch.model_validate({'status': system_status})
    with pytest.raises(ValidationError):
        plugin_api.TaskContentPatch.model_validate({'title': 'Updated', 'assignee': 'default'})
    with pytest.raises(ValidationError):
        plugin_api.CommentCreate.model_validate({'body': 'Note', 'author': 'spoofed'})


@dataclass
class Task:
    id: str = 'parent'
    title: str = 'Parent'
    body: str | None = None
    status: str = 'ready'
    priority: int = 0
    assignee: str | None = None
    tenant: str | None = None
    created_at: int = 1
    started_at: int | None = None
    completed_at: int | None = None


class Row(dict):
    pass


class Connection:
    def __init__(self):
        self.closed = False
        self.pragmas = []

    def execute(self, query):
        if query.startswith('PRAGMA '):
            self.pragmas.append(query)
            return Cursor([])
        if 'MAX(id)' in query:
            return Cursor([Row(m=7)])
        if 'task_links' in query:
            return Cursor([Row(parent_id='parent', child_id='child')])
        raise AssertionError(query)

    def close(self):
        self.closed = True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class FakeKanban:
    DEFAULT_BOARD = 'default'

    def __init__(self):
        self.connection = Connection()
        self.current_board = 'default'
        self.path_calls = []

    def _normalize_board_slug(self, value):
        if '/' in value:
            raise ValueError('invalid board slug')
        return value

    def board_exists(self, value):
        return value in {'default', 'work'}

    def get_current_board(self):
        return self.current_board

    def init_db(self, *, board=None):
        return None

    def connect(self, *, board=None):
        return self.connection

    def kanban_db_path(self, board=None):
        self.path_calls.append(board)
        return Path('/tmp/kanban.db')

    def list_tasks(self, conn, *, include_archived=False):
        return [Task(), Task(id='child', title='Child', status='todo', created_at=2)]

    def latest_summaries(self, conn, task_ids):
        return {'parent': 'summary'}

    def list_boards(self, *, include_archived=True):
        return [
            {
                'slug': 'default',
                'name': 'Default',
                'archived': False,
                'db_path': '/private/default/kanban.db',
            },
            {
                'slug': 'work',
                'name': 'Work',
                'archived': False,
                'default_workdir': '/private/work',
            },
        ]


def test_graph_endpoint_returns_one_read_only_projection(monkeypatch):
    fake = FakeKanban()
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setattr(plugin_api, '_connection', lambda _path: fake.connection)

    payload = plugin_api.graph(board='default', include_archived=False)

    assert payload['board'] == {'slug': 'default', 'latest_event_id': 7}
    assert payload['nodes'][0]['latest_summary'] == 'summary'
    assert payload['edges'] == [{'id': 'parent->child', 'source': 'parent', 'target': 'child'}]
    assert fake.connection.closed is True


def test_graph_endpoint_rejects_malformed_and_unknown_boards(monkeypatch):
    monkeypatch.setattr(plugin_api, 'kanban_db', FakeKanban())

    with pytest.raises(HTTPException) as malformed:
        plugin_api.graph(board='../secret', include_archived=False)
    assert malformed.value.status_code == 400

    with pytest.raises(HTTPException) as missing:
        plugin_api.graph(board='missing', include_archived=False)
    assert missing.value.status_code == 404


def test_boards_endpoint_returns_available_boards(monkeypatch):
    fake = FakeKanban()
    fake.current_board = 'work'
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)

    payload = plugin_api.boards()

    assert payload['current'] == 'work'
    assert payload['boards'][1]['is_current'] is True
    assert 'db_path' not in payload['boards'][0]
    assert 'default_workdir' not in payload['boards'][1]


def test_blank_board_is_resolved_once_and_used_for_path_and_metadata(monkeypatch):
    fake = FakeKanban()
    fake.current_board = 'work'
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setattr(plugin_api, '_connection', lambda _path: fake.connection)

    payload = plugin_api.graph(board='', include_archived=False)

    assert payload['board']['slug'] == 'work'
    assert fake.path_calls == ['work']


def test_pinned_database_only_exposes_and_accepts_current_board(monkeypatch):
    fake = FakeKanban()
    fake.current_board = 'work'
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setenv('HERMES_KANBAN_DB', '/tmp/work.db')

    assert [item['slug'] for item in plugin_api.boards()['boards']] == ['work']
    with pytest.raises(HTTPException) as mismatch:
        plugin_api.graph(board='default', include_archived=False)
    assert mismatch.value.status_code == 409


def test_connection_opens_sqlite_database_in_read_only_mode(monkeypatch, tmp_path):
    path = tmp_path / 'kanban.db'
    path.touch()
    fake = FakeKanban()
    fake.kanban_db_path = lambda board=None: path
    captured = {}

    def connect(database, **kwargs):
        captured.update(database=database, kwargs=kwargs)
        return fake.connection

    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setattr(plugin_api.sqlite3, 'connect', connect)

    assert plugin_api._connection(path) is fake.connection
    assert captured['database'].startswith('file:')
    assert captured['database'].endswith('?mode=ro')
    assert captured['kwargs']['uri'] is True
    assert fake.connection.pragmas == [
        'PRAGMA query_only=ON',
        'PRAGMA busy_timeout=2000',
        'PRAGMA trusted_schema=OFF',
    ]


def test_connection_closes_when_read_only_setup_fails(monkeypatch, tmp_path):
    path = tmp_path / 'kanban.db'
    path.touch()
    connection = Connection()

    def fail(_query):
        raise RuntimeError('pragma failed')

    monkeypatch.setattr(connection, 'execute', fail)
    monkeypatch.setattr(plugin_api.sqlite3, 'connect', lambda *_args, **_kwargs: connection)

    with pytest.raises(RuntimeError, match='pragma failed'):
        plugin_api._connection(path)
    assert connection.closed is True


@pytest.fixture
def editable_task(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    conn = plugin_api.kanban_db.connect(board='default')
    try:
        task_id = plugin_api.kanban_db.create_task(
            conn,
            title='Editable task',
            body='Original body',
            initial_status='blocked',
            board='default',
        )
    finally:
        conn.close()
    return task_id


def test_task_detail_and_content_patch_use_canonical_kanban_events(editable_task):
    updated = plugin_api.update_task_content(
        editable_task,
        plugin_api.TaskContentPatch(title='  Updated task  ', body='Updated body'),
        board='default',
    )
    detail = plugin_api.task_detail(editable_task, board='default')

    assert updated['task']['title'] == 'Updated task'
    assert detail['task']['body'] == 'Updated body'
    assert detail['comments'] == []
    assert detail['events'][-1]['kind'] == 'edited'
    assert detail['links'] == {'parents': [], 'children': []}


def test_status_patch_uses_canonical_transitions(editable_task):
    ready = plugin_api.update_task_content(
        editable_task,
        plugin_api.TaskContentPatch(status='ready'),
        board='default',
    )
    assert ready['task']['status'] == 'ready'

    done = plugin_api.update_task_content(
        editable_task,
        plugin_api.TaskContentPatch(status='done'),
        board='default',
    )
    assert done['task']['status'] == 'done'

    detail = plugin_api.task_detail(editable_task, board='default')
    assert [event['kind'] for event in detail['events'][-2:]] == ['unblocked', 'completed']


def test_ready_status_rejects_unfinished_parent(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    conn = plugin_api.kanban_db.connect(board='default')
    try:
        parent = plugin_api.kanban_db.create_task(conn, title='Parent', initial_status='blocked', board='default')
        assert plugin_api.kanban_db.unblock_task(conn, parent)
        child = plugin_api.kanban_db.create_task(conn, title='Child', initial_status='blocked', board='default')
        plugin_api.kanban_db.link_tasks(conn, parent, child)
        with plugin_api.kanban_db.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'todo' WHERE id = ?", (child,))
    finally:
        conn.close()

    with pytest.raises(HTTPException) as blocked:
        plugin_api.update_task_content(
            child,
            plugin_api.TaskContentPatch(status='ready'),
            board='default',
        )
    assert blocked.value.status_code == 409
    assert 'Parent' in blocked.value.detail

    conn = plugin_api.kanban_db.connect(board='default')
    try:
        with plugin_api.kanban_db.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (child,))
    finally:
        conn.close()

    with pytest.raises(HTTPException) as still_blocked:
        plugin_api.update_task_content(
            child,
            plugin_api.TaskContentPatch(status='ready'),
            board='default',
        )
    assert still_blocked.value.status_code == 409
    assert 'Parent' in still_blocked.value.detail


def test_comment_write_uses_fixed_desktop_author_and_is_visible_in_detail(editable_task):
    plugin_api.create_comment(
        editable_task,
        plugin_api.CommentCreate(body='  A useful note  '),
        board='default',
    )

    detail = plugin_api.task_detail(editable_task, board='default')
    assert [(item['author'], item['body']) for item in detail['comments']] == [('desktop', 'A useful note')]
    assert detail['events'][-1]['kind'] == 'commented'


def test_content_write_rejects_empty_title_and_comment(editable_task):
    with pytest.raises(HTTPException) as title_error:
        plugin_api.update_task_content(
            editable_task,
            plugin_api.TaskContentPatch(title='   '),
            board='default',
        )
    assert title_error.value.status_code == 400

    with pytest.raises(HTTPException) as comment_error:
        plugin_api.create_comment(
            editable_task,
            plugin_api.CommentCreate(body='   '),
            board='default',
        )
    assert comment_error.value.status_code == 400


def test_route_surface_keeps_dependency_links_read_only():
    routes = {
        (getattr(route, 'path', ''), frozenset(getattr(route, 'methods', set()) or set()))
        for route in plugin_api.router.routes
    }

    assert ('/tasks/{task_id}', frozenset({'PATCH'})) in routes
    assert ('/tasks/{task_id}/comments', frozenset({'POST'})) in routes
    assert not any('links' in path and methods & {'POST', 'PATCH', 'PUT', 'DELETE'} for path, methods in routes)
