from pathlib import Path

import install


def test_resolve_hermes_home_honors_active_profile(monkeypatch):
    monkeypatch.setenv('HERMES_HOME', '/tmp/hermes-profile')

    assert install.resolve_hermes_home() == Path('/tmp/hermes-profile')


def test_install_paths_are_scoped_to_resolved_home():
    backend, frontend = install.install_paths(Path('/tmp/hermes-profile'))

    assert backend == Path('/tmp/hermes-profile/plugins/kanban-graph/dashboard')
    assert frontend == Path('/tmp/hermes-profile/desktop-plugins/kanban-graph')


def test_replace_directory_atomically_removes_stale_files(tmp_path):
    target = tmp_path / 'plugin'
    staged = tmp_path / '.plugin.staged'
    target.mkdir()
    staged.mkdir()
    (target / 'stale.js').write_text('old')
    (staged / 'plugin.js').write_text('new')

    install._replace_directory(staged, target)

    assert (target / 'plugin.js').read_text() == 'new'
    assert not (target / 'stale.js').exists()
    assert not staged.exists()
    assert not list(tmp_path.glob('.plugin.backup-*'))