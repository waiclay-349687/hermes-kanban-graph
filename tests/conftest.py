import pytest

# Variables that change how hermes_cli.kanban_db resolves board paths. A test run
# launched from inside a Hermes worker or delegated agent inherits them, and the
# fence marker turns every pinned/explicit path into a read-only one.
_KANBAN_ENV = (
    'HERMES_KANBAN_DB',
    'HERMES_KANBAN_BOARD',
    'HERMES_KANBAN_TASK',
    'HERMES_KANBAN_WORKSPACES_ROOT',
    'HERMES_KANBAN_ATTACHMENTS_ROOT',
    'HERMES_DELEGATED_CHILD_CONTEXT',
)


@pytest.fixture(autouse=True)
def isolated_kanban_home(monkeypatch, tmp_path):
    """Every test gets a throwaway Kanban home, never the real ~/.hermes/kanban."""
    for name in _KANBAN_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path / 'kanban-home'))
