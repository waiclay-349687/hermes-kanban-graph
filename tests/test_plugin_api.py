from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.dashboard import plugin_api


def _connect(board='default'):
    connect = getattr(plugin_api.kanban_db, 'connect', None)
    if connect is None:
        from hermes_cli import kanban_db_connect
        connect = kanban_db_connect.connect
    return connect(board=board)


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

    def execute(self, query, params=()):
        if query.startswith('PRAGMA '):
            self.pragmas.append(query)
            return Cursor([])
        if 'MAX(id)' in query:
            return Cursor([Row(m=7)])
        if query == 'SELECT id FROM tasks':
            return Cursor([Row(id='parent'), Row(id='child')])
        if "status = 'archived'" in query:
            return Cursor([Row(n=3)])
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


def test_graph_endpoint_returns_one_read_only_projection(monkeypatch, tmp_path):
    fake = FakeKanban()
    db = tmp_path / 'kanban.db'
    db.touch()
    fake.kanban_db_path = lambda board=None: db
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setattr(plugin_api, '_connection', lambda _path: fake.connection)

    payload = plugin_api.graph(board='default', include_archived=False)

    assert payload['board'] == {'slug': 'default', 'latest_event_id': 7, 'initialized': True}
    assert payload['archived_count'] == 3
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
    conn = _connect('default')
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

    with pytest.raises(HTTPException) as no_evidence:
        plugin_api.update_task_content(
            editable_task,
            plugin_api.TaskContentPatch(status='done'),
            board='default',
        )
    assert no_evidence.value.status_code == 400
    assert 'evidence' in no_evidence.value.detail

    done = plugin_api.update_task_content(
        editable_task,
        plugin_api.TaskContentPatch(status='done', summary='  Shipped from the graph  '),
        board='default',
    )
    assert done['task']['status'] == 'done'
    assert done['task']['latest_summary'] == 'Shipped from the graph'

    detail = plugin_api.task_detail(editable_task, board='default')
    assert detail['events'][-1]['kind'] == 'completed'
    assert 'unblocked' in [event['kind'] for event in detail['events']]


def test_ready_status_rejects_unfinished_parent(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    conn = _connect('default')
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

    conn = _connect('default')
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


def test_summary_is_only_accepted_with_done(editable_task):
    with pytest.raises(HTTPException) as error:
        plugin_api.update_task_content(
            editable_task,
            plugin_api.TaskContentPatch(status='ready', summary='nope'),
            board='default',
        )
    assert error.value.status_code == 400


def test_archived_parent_satisfies_ready_like_the_official_board(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    conn = _connect('default')
    try:
        parent = plugin_api.kanban_db.create_task(conn, title='Parent', initial_status='blocked', board='default')
        child = plugin_api.kanban_db.create_task(conn, title='Child', initial_status='blocked', board='default')
        plugin_api.kanban_db.link_tasks(conn, parent, child)
        assert plugin_api.kanban_db.archive_task(conn, parent)
        with plugin_api.kanban_db.write_txn(conn):
            conn.execute("UPDATE tasks SET status = 'todo' WHERE id = ?", (child,))
    finally:
        conn.close()

    moved = plugin_api.update_task_content(child, plugin_api.TaskContentPatch(status='ready'), board='default')
    assert moved['task']['status'] == 'ready'


def test_title_edit_fires_core_update_hook(editable_task, monkeypatch):
    seen = []
    monkeypatch.setattr(
        plugin_api.kanban_db,
        'notify_task_updated',
        lambda conn, task_id, fields, board=None: seen.append((task_id, list(fields), board)),
    )
    plugin_api.update_task_content(editable_task, plugin_api.TaskContentPatch(title='Renamed'), board='default')
    assert seen == [(editable_task, ['title'], 'default')]


def test_writes_refuse_instead_of_diverging_when_core_backend_is_missing(editable_task, monkeypatch, tmp_path):
    monkeypatch.setattr(plugin_api, '_core_module', None)
    monkeypatch.setattr(plugin_api, '_core_dashboard_path', lambda: tmp_path / 'missing' / 'plugin_api.py')
    monkeypatch.setattr(plugin_api, '_CORE_REQUIRED', ('_definitely_not_a_core_symbol',))
    with pytest.raises(HTTPException) as error:
        plugin_api.update_task_content(editable_task, plugin_api.TaskContentPatch(status='todo'), board='default')
    assert error.value.status_code == 503


def test_detail_hides_worker_internals(editable_task):
    task = plugin_api.task_detail(editable_task, board='default')['task']
    assert not {'claim_lock', 'claim_expires', 'worker_pid', 'worker_started_at'} & set(task)


def test_read_connection_authorizer_denies_writes(tmp_path):
    import sqlite3

    path = tmp_path / 'kanban.db'
    raw = sqlite3.connect(path)
    raw.execute('CREATE TABLE tasks (id TEXT, status TEXT)')
    raw.execute("INSERT INTO tasks VALUES ('a', 'ready')")
    raw.commit()
    raw.close()

    conn = plugin_api._connection(path)
    try:
        assert conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0] == 1
        for statement in ("INSERT INTO tasks VALUES ('b', 'todo')", 'DROP TABLE tasks', "ATTACH DATABASE ':memory:' AS x"):
            with pytest.raises(sqlite3.DatabaseError):
                conn.execute(statement)
    finally:
        conn.close()


def test_graph_for_uninitialized_board_is_empty_and_creates_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    payload = plugin_api.graph(board='default', include_archived=False)
    assert payload['board']['initialized'] is False
    assert payload['nodes'] == [] and payload['edges'] == []
    assert not (tmp_path / 'kanban.db').exists()


def test_boards_report_counts_and_skip_archived_boards(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    monkeypatch.delenv('HERMES_KANBAN_BOARD', raising=False)
    plugin_api.kanban_db.create_board('work', name='工作')
    plugin_api.kanban_db.create_board('old', name='Old')
    plugin_api.kanban_db.write_board_metadata('old', archived=True)
    conn = _connect('work')
    try:
        plugin_api.kanban_db.create_task(conn, title='一个任务', initial_status='blocked', board='work')
        done = plugin_api.kanban_db.create_task(conn, title='归档', initial_status='blocked', board='work')
        plugin_api.kanban_db.archive_task(conn, done)
    finally:
        conn.close()

    payload = plugin_api.boards()
    by_slug = {item['slug']: item for item in payload['boards']}
    assert by_slug['work']['name'] == '工作'
    assert by_slug['work']['total'] == 1
    assert by_slug['work']['by_status'] == {'blocked': 1, 'archived': 1}
    assert by_slug['old']['archived'] is True and 'total' not in by_slug['old']
    assert by_slug['default']['initialized'] is False
    assert not any('db_path' in item for item in payload['boards'])

    graph = plugin_api.graph(board='work', include_archived=False)
    assert [node['title'] for node in graph['nodes']] == ['一个任务']
    assert graph['archived_count'] == 1
