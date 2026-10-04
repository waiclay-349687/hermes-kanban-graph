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

def test_plugin_enabled_reads_config_without_rewriting(tmp_path):
    import pytest
    pytest.importorskip('yaml')
    config = tmp_path / 'config.yaml'
    config.write_text('plugins:\n  enabled:\n    - other\n    - kanban-graph\n  disabled: []\n')
    before = config.read_bytes()

    assert install.plugin_enabled(tmp_path) is True
    assert config.read_bytes() == before

    config.write_text('plugins:\n  enabled: [kanban-graph]\n  disabled: [kanban-graph]\n')
    assert install.plugin_enabled(tmp_path) is False
    assert install.plugin_enabled(tmp_path / 'missing') is False


def test_stage_copies_backend_and_bundle(tmp_path, monkeypatch):
    dist = install.ROOT / 'dist' / 'plugin.js'
    if not dist.exists():
        import pytest
        pytest.skip('build dist/plugin.js first')
    backend, frontend = tmp_path / 'b', tmp_path / 'f'
    install.stage(backend, frontend)
    assert (backend / 'plugin.yaml').exists()
    assert sorted(p.name for p in (backend / 'dashboard').iterdir()) == ['dist', 'graph_data.py', 'manifest.json', 'plugin_api.py']
    assert (frontend / 'plugin.js').read_bytes() == dist.read_bytes()
