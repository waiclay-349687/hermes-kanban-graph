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


def test_blank_board_resolves_path_like_core_and_labels_the_current_board(monkeypatch):
    fake = FakeKanban()
    fake.current_board = 'work'
    monkeypatch.setattr(plugin_api, 'kanban_db', fake)
    monkeypatch.setattr(plugin_api, '_connection', lambda _path: fake.connection)

    payload = plugin_api.graph(board='', include_archived=False)

    assert payload['board']['slug'] == 'work'
    # ``None`` (not the current slug) reaches kanban_db_path, so a HERMES_KANBAN_DB
    # pin applies exactly as it does for core's omitted ``board``.
    assert fake.path_calls == [None]


def test_pinned_database_defers_to_core_path_rules(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path / 'home'))
    monkeypatch.delenv('HERMES_KANBAN_BOARD', raising=False)
    pinned = tmp_path / 'pinned.db'
    monkeypatch.setenv('HERMES_KANBAN_DB', str(pinned))
    plugin_api.kanban_db.create_board('work', name='Work')

    listed = [item['slug'] for item in plugin_api.boards(counts=False)['boards']]
    assert {'default', 'work'} <= set(listed)
    # No plugin-specific 409: an explicit board is answered like core answers it.
    assert plugin_api.graph(board='work', include_archived=False)['board']['slug'] == 'work'
    assert plugin_api.kanban_db.kanban_db_path(None) == pinned


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


def test_workflow_route_serves_the_core_manual_matrix():
    from hermes_cli import kanban_workflow

    payload = plugin_api.workflow()
    assert payload == kanban_workflow.DEFAULT_WORKFLOW.to_dict()
    assert 'done' not in payload['manual']['todo']
    assert 'blocked' not in payload['manual']['done']


def test_dispatch_nudge_delegates_to_core_with_explicit_arguments(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    calls = []

    def fake_dispatch_once(conn, **kwargs):
        calls.append(kwargs)
        return {'spawned': []}

    # Never run the real dispatcher in tests: it would spawn workers.
    monkeypatch.setattr(core.kbd, 'dispatch_once', fake_dispatch_once)
    plugin_api.dispatch(board='default')
    assert calls == [{'dry_run': False, 'max_spawn': 8, 'board': 'default'}]


def test_dispatch_nudge_never_creates_a_board_database(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    with pytest.raises(HTTPException) as error:
        plugin_api.dispatch(board='default')
    assert error.value.status_code == 404
    assert not (tmp_path / 'kanban.db').exists()


def test_comment_on_uninitialized_board_is_refused_without_creating_it(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    with pytest.raises(HTTPException) as error:
        plugin_api.create_comment('t_missing', plugin_api.CommentCreate(body='hi'), board='default')
    assert error.value.status_code == 404
    assert not (tmp_path / 'kanban.db').exists()


def test_comments_use_the_core_write_path(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    opened = []
    original = core._board_conn

    def spy(board):
        opened.append(board)
        return original(board)

    monkeypatch.setattr(core, '_board_conn', spy)
    plugin_api.create_comment(editable_task, plugin_api.CommentCreate(body='via core'), board='default')
    assert opened == ['default']
    assert not hasattr(plugin_api, '_write_connection')


def test_completing_a_reopened_task_keeps_its_stored_result(editable_task):
    plugin_api.update_task_content(editable_task, plugin_api.TaskContentPatch(status='ready'), board='default')
    conn = _connect('default')
    try:
        assert plugin_api.kanban_db.complete_task(conn, editable_task, result='Original result')
    finally:
        conn.close()
    plugin_api.update_task_content(editable_task, plugin_api.TaskContentPatch(status='ready'), board='default')
    assert plugin_api.task_detail(editable_task, board='default')['task']['result'] == 'Original result'

    done = plugin_api.update_task_content(editable_task, plugin_api.TaskContentPatch(status='done'), board='default')
    assert done['task']['status'] == 'done'
    assert done['task']['result'] == 'Original result'


def test_detail_events_skip_heartbeats_and_keep_the_newest(editable_task):
    conn = _connect('default')
    try:
        with plugin_api.kanban_db.write_txn(conn):
            for index in range(plugin_api.EVENT_LIMIT + 10):
                plugin_api.kanban_db._append_event(conn, editable_task, 'heartbeat', None)
                plugin_api.kanban_db._append_event(conn, editable_task, 'note', {'n': index})
    finally:
        conn.close()

    events = plugin_api.task_detail(editable_task, board='default')['events']
    assert len(events) == plugin_api.EVENT_LIMIT
    assert all(event['kind'] != 'heartbeat' for event in events)
    assert events[-1]['payload'] == {'n': plugin_api.EVENT_LIMIT + 9}
    assert [event['id'] for event in events] == sorted(event['id'] for event in events)


def test_route_surface_includes_workflow_and_dispatch():
    routes = {
        (getattr(route, 'path', ''), frozenset(getattr(route, 'methods', set()) or set()))
        for route in plugin_api.router.routes
    }
    assert ('/workflow', frozenset({'GET'})) in routes
    assert ('/dispatch', frozenset({'POST'})) in routes


# --- live events --------------------------------------------------------------
#
# Starlette's TestClient needs an HTTP client package this venv does not ship,
# so the socket is driven over raw ASGI messages instead.

import asyncio
import json


class _Closed(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Socket:
    def __init__(self, outgoing):
        self._outgoing = outgoing

    async def receive_json(self, timeout=10.0):
        message = await asyncio.wait_for(self._outgoing.get(), timeout)
        if message['type'] == 'websocket.close':
            raise _Closed(message.get('code', 1000))
        assert message['type'] == 'websocket.send', message
        return json.loads(message['text'])

    async def receive_events(self):
        while True:
            frame = await self.receive_json()
            if frame.get('events'):
                return frame


async def _with_events_socket(query, script):
    """Open ``/events?<query>`` on our router, run ``script(socket)`` once the
    handshake is accepted, then disconnect. Raises ``_Closed`` on a refusal."""
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(plugin_api.router, prefix='/api/plugins/kanban-graph')
    incoming: asyncio.Queue = asyncio.Queue()
    outgoing: asyncio.Queue = asyncio.Queue()
    await incoming.put({'type': 'websocket.connect'})
    scope = {
        'type': 'websocket',
        'asgi': {'version': '3.0'},
        'scheme': 'ws',
        'path': '/api/plugins/kanban-graph/events',
        'raw_path': b'/api/plugins/kanban-graph/events',
        'query_string': query.encode(),
        'root_path': '',
        'headers': [],
        'client': ('127.0.0.1', 1),
        'server': ('127.0.0.1', 80),
        'subprotocols': [],
        'state': {},
    }
    server = asyncio.create_task(app(scope, incoming.get, outgoing.put))
    try:
        opened = await asyncio.wait_for(outgoing.get(), 10.0)
        if opened['type'] == 'websocket.close':
            raise _Closed(opened.get('code', 1000))
        assert opened['type'] == 'websocket.accept', opened
        return await script(_Socket(outgoing))
    finally:
        await incoming.put({'type': 'websocket.disconnect', 'code': 1000})
        await asyncio.wait_for(server, 10.0)


def _open_events(query, script=None):
    async def default(socket):
        return await socket.receive_json()

    return asyncio.run(_with_events_socket(query, script or default))


def _create_task(title):
    conn = _connect('default')
    try:
        return plugin_api.kanban_db.create_task(conn, title=title, initial_status='blocked', board='default')
    finally:
        conn.close()


def test_events_route_is_a_websocket_on_our_router():
    from starlette.routing import WebSocketRoute

    paths = {route.path for route in plugin_api.router.routes if isinstance(route, WebSocketRoute)}
    assert '/events' in paths


def _is_hello(frame):
    return frame.get('hello') is True and frame.get('events') == [] and isinstance(frame.get('cursor'), int)


def test_events_stream_advances_the_cursor_with_core_auth(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    gate_calls = []
    monkeypatch.setattr(core, '_ws_upgrade_authorized', lambda ws: gate_calls.append(ws) or True)

    async def script(socket):
        assert _is_hello(await socket.receive_json())
        first = await socket.receive_events()
        assert any(event['task_id'] == editable_task for event in first['events'])
        second_task = await asyncio.to_thread(_create_task, 'Pushed live')
        second = await socket.receive_events()
        assert second['cursor'] > first['cursor']
        assert all(event['id'] > first['cursor'] for event in second['events'])
        assert any(event['task_id'] == second_task for event in second['events'])

    _open_events('board=default&since=0', script)
    assert len(gate_calls) == 1  # core's single-use auth gate ran exactly once


def test_events_without_since_start_at_the_tail(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    monkeypatch.setattr(core, '_ws_upgrade_authorized', lambda ws: True)

    async def script(socket):
        hello = await socket.receive_json()
        assert _is_hello(hello) and hello['cursor'] > 0
        new_task = await asyncio.to_thread(_create_task, 'After open')
        frame = await socket.receive_events()
        assert all(event['id'] > hello['cursor'] for event in frame['events'])
        assert any(event['task_id'] == new_task for event in frame['events'])

    _open_events('board=default', script)


def test_events_keepalive_hello_while_idle(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    monkeypatch.setattr(core, '_ws_upgrade_authorized', lambda ws: True)
    monkeypatch.setattr(plugin_api, 'KEEPALIVE_SECONDS', 0.5)

    async def script(socket):
        first = await socket.receive_json()
        second = await socket.receive_json()
        assert _is_hello(first) and _is_hello(second)
        assert second['cursor'] == first['cursor']

    _open_events('board=default', script)


def test_events_keep_the_core_auth_gate(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    monkeypatch.setattr(core, '_ws_upgrade_authorized', lambda ws: False)
    with pytest.raises(_Closed) as closed:
        _open_events('board=default')
    assert closed.value.code == 1008


@pytest.mark.parametrize('board', ['missing-board', '..%2Fetc'])
def test_events_refuse_unknown_boards_before_auth(board, monkeypatch):
    monkeypatch.setattr(plugin_api, '_core_ws_gate', lambda: pytest.fail('auth must not be reached'))
    with pytest.raises(_Closed) as closed:
        _open_events(f'board={board}')
    assert closed.value.code == 1008


def test_events_never_create_an_uninitialized_board_database(monkeypatch):
    path = plugin_api.kanban_db.kanban_db_path('default')
    assert not path.exists()
    monkeypatch.setattr(plugin_api, '_core_ws_gate', lambda: pytest.fail('auth must not be reached'))
    with pytest.raises(_Closed) as closed:
        _open_events('board=default')
    assert closed.value.code == 1008
    assert not path.exists()


def test_events_close_and_never_recreate_a_deleted_database(editable_task, monkeypatch):
    core = plugin_api._core_dashboard()
    monkeypatch.setattr(core, '_ws_upgrade_authorized', lambda ws: True)
    path = plugin_api.kanban_db.kanban_db_path('default')

    async def script(socket):
        assert _is_hello(await socket.receive_json())
        for suffix in ('', '-wal', '-shm'):
            candidate = path.with_name(path.name + suffix)
            if candidate.exists():
                candidate.unlink()
        with pytest.raises(_Closed) as closed:
            while True:
                await socket.receive_json()
        assert closed.value.code == 1011

    _open_events('board=default', script)
    assert not path.exists()


def test_events_close_1011_without_a_core_auth_gate(editable_task, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(plugin_api, '_core_dashboard', lambda: SimpleNamespace())
    with pytest.raises(_Closed) as closed:
        _open_events('board=default')
    assert closed.value.code == 1011


def test_graph_cursor_is_read_before_the_snapshot(editable_task):
    graph = plugin_api.graph(board='default', include_archived=False)
    conn = _connect('default')
    try:
        tail = conn.execute('SELECT COALESCE(MAX(id), 0) AS m FROM task_events').fetchone()[0]
    finally:
        conn.close()
    assert graph['board']['latest_event_id'] <= tail


# --- all boards ---------------------------------------------------------------

def _all_boards_home(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    monkeypatch.delenv('HERMES_KANBAN_BOARD', raising=False)
    plugin_api.kanban_db.create_board('alpha', name='Alpha')
    plugin_api.kanban_db.create_board('beta', name='Beta')
    plugin_api.kanban_db.create_board('old', name='Old')
    ids = {}
    for slug in ('alpha', 'beta', 'old'):
        conn = _connect(slug)
        try:
            parent = plugin_api.kanban_db.create_task(conn, title=f'{slug} parent', initial_status='blocked', board=slug)
            child = plugin_api.kanban_db.create_task(conn, title=f'{slug} child', parents=[parent], initial_status='blocked', board=slug)
            ids[slug] = (parent, child)
        finally:
            conn.close()
    plugin_api.kanban_db.write_board_metadata('old', archived=True)
    # A board listed by board.json alone: its database was never created.
    plugin_api.kanban_db.write_board_metadata('ghost', name='Ghost')
    return ids


def test_all_boards_graph_tags_every_node_and_edge_with_its_board(monkeypatch, tmp_path):
    ids = _all_boards_home(monkeypatch, tmp_path)

    payload = plugin_api.graph_all(include_archived=False)

    assert payload['board']['slug'] == plugin_api.ALL_BOARDS
    assert payload['board']['initialized'] is True
    by_board = {}
    for node in payload['nodes']:
        by_board.setdefault(node['board'], set()).add(node['id'])
    assert by_board == {'alpha': set(ids['alpha']), 'beta': set(ids['beta'])}
    edges = {(edge['board'], edge['source'], edge['target']) for edge in payload['edges']}
    assert edges == {('alpha', *ids['alpha']), ('beta', *ids['beta'])}
    # Edges never cross boards.
    node_board = {(node['board'], node['id']) for node in payload['nodes']}
    assert all((edge['board'], edge['source']) in node_board and (edge['board'], edge['target']) in node_board for edge in payload['edges'])
    meta = {item['slug']: item for item in payload['boards']}
    assert meta['alpha']['name'] == 'Alpha' and meta['alpha']['total'] == 2 and meta['alpha']['initialized'] is True
    assert meta['alpha']['latest_event_id'] > 0
    assert payload['total_count'] == 4 and payload['truncated'] is False


def test_all_boards_graph_skips_archived_and_uninitialized_boards(monkeypatch, tmp_path):
    _all_boards_home(monkeypatch, tmp_path)

    payload = plugin_api.graph_all(include_archived=False)

    slugs = {item['slug'] for item in payload['boards']}
    assert 'old' not in slugs
    assert not any(node['board'] in {'old', 'ghost', 'default'} for node in payload['nodes'])
    meta = {item['slug']: item for item in payload['boards']}
    assert meta['ghost']['initialized'] is False and meta['ghost']['total'] == 0
    # Reading never creates a database for a board that has none.
    assert not plugin_api.kanban_db.kanban_db_path('ghost').exists()
    assert not plugin_api.kanban_db.kanban_db_path('default').exists()


def test_all_boards_graph_applies_a_global_cap_honestly(monkeypatch, tmp_path):
    _all_boards_home(monkeypatch, tmp_path)
    monkeypatch.setattr(plugin_api, 'MAX_ALL_NODES', 3)

    payload = plugin_api.graph_all(include_archived=False)

    assert len(payload['nodes']) == 3
    assert payload['truncated'] is True and payload['total_count'] == 4
    meta = {item['slug']: item for item in payload['boards']}
    assert meta['alpha']['truncated'] is False and meta['beta']['truncated'] is True
    assert meta['beta']['shown'] == 1 and meta['beta']['total'] == 2
    # The link to the task beyond the cap is counted, not dropped silently.
    beta = [node for node in payload['nodes'] if node['board'] == 'beta']
    assert sum(node['truncated_parent_count'] + node['truncated_child_count'] for node in beta) == 1


def test_all_boards_sentinel_is_not_a_board_slug(monkeypatch, tmp_path):
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path))
    monkeypatch.delenv('HERMES_KANBAN_DB', raising=False)
    with pytest.raises(ValueError):
        plugin_api.kanban_db._normalize_board_slug(plugin_api.ALL_BOARDS)
    with pytest.raises(HTTPException) as bad:
        plugin_api.graph(board=plugin_api.ALL_BOARDS, include_archived=False)
    assert bad.value.status_code == 400


def test_all_boards_route_is_registered_read_only():
    routes = {(getattr(route, 'path', ''), tuple(sorted(getattr(route, 'methods', None) or ()))) for route in plugin_api.router.routes}
    assert ('/graph/all', ('GET',)) in routes
