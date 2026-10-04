#!/usr/bin/env python3
"""Build, verify, and atomically install kanban-graph into HERMES_HOME.

Installs two directories (each swapped in atomically; the previous copy is kept
as a hidden backup only until the swap succeeds):

  <home>/plugins/kanban-graph/            Python backend (gateway, needs restart)
  <home>/desktop-plugins/kanban-graph/    Desktop renderer (hot-reloads)

The plugin is enabled in config.yaml only when it is not already enabled, so an
existing config is never rewritten needlessly.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLUGIN_ID = "kanban-graph"
BACKEND_FILES = ("manifest.json", "plugin_api.py", "graph_data.py")


def resolve_hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def install_paths(home: Path) -> tuple[Path, Path]:
    return (
        home / "plugins" / PLUGIN_ID / "dashboard",
        home / "desktop-plugins" / PLUGIN_ID,
    )


def _replace_directory(staged: Path, target: Path) -> None:
    backup = target.with_name(f".{target.name}.backup-{os.getpid()}")
    shutil.rmtree(backup, ignore_errors=True)
    if target.exists():
        target.replace(backup)
    try:
        staged.replace(target)
    except Exception:
        if backup.exists() and not target.exists():
            backup.replace(target)
        raise
    else:
        shutil.rmtree(backup, ignore_errors=True)


def plugin_enabled(home: Path) -> bool | None:
    """True/False from config.yaml ``plugins.enabled``/``disabled``; None if unknown."""
    config = home / "config.yaml"
    if not config.is_file():
        return False
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        return None
    try:
        data = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    plugins = data.get("plugins") or {}
    enabled = plugins.get("enabled") or []
    disabled = plugins.get("disabled") or []
    return PLUGIN_ID in enabled and PLUGIN_ID not in disabled


def stage(backend_stage: Path, frontend_stage: Path) -> None:
    shutil.rmtree(backend_stage, ignore_errors=True)
    shutil.rmtree(frontend_stage, ignore_errors=True)
    (backend_stage / "dashboard").mkdir(parents=True, exist_ok=True)
    frontend_stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "backend" / "plugin.yaml", backend_stage / "plugin.yaml")
    shutil.copy2(ROOT / "backend" / "__init__.py", backend_stage / "__init__.py")
    for name in BACKEND_FILES:
        shutil.copy2(ROOT / "backend" / "dashboard" / name, backend_stage / "dashboard" / name)
    shutil.copytree(ROOT / "backend" / "dashboard" / "dist", backend_stage / "dashboard" / "dist")
    shutil.copy2(ROOT / "dist" / "plugin.js", frontend_stage / "plugin.js")
    source_map = ROOT / "dist" / "plugin.js.map"
    if source_map.exists():
        shutil.copy2(source_map, frontend_stage / "plugin.js.map")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Install kanban-graph into HERMES_HOME")
    parser.add_argument("--skip-verify", action="store_true", help="install the existing dist/ without `npm run verify`")
    args = parser.parse_args(argv)

    environment = os.environ.copy()
    home = resolve_hermes_home()
    environment["HERMES_HOME"] = str(home)
    backend, frontend = install_paths(home)
    backend_root = backend.parent
    backend_stage = backend_root.with_name(f".{backend_root.name}.staged-{os.getpid()}")
    frontend_stage = frontend.with_name(f".{frontend.name}.staged-{os.getpid()}")

    if not args.skip_verify:
        subprocess.run(["npm", "run", "verify"], cwd=ROOT, check=True, env=environment)
    if not (ROOT / "dist" / "plugin.js").is_file():
        raise SystemExit("dist/plugin.js is missing; run `npm run build` first")
    backend_root.parent.mkdir(parents=True, exist_ok=True)
    frontend.parent.mkdir(parents=True, exist_ok=True)
    try:
        stage(backend_stage, frontend_stage)
        _replace_directory(backend_stage, backend_root)
        _replace_directory(frontend_stage, frontend)
    finally:
        shutil.rmtree(backend_stage, ignore_errors=True)
        shutil.rmtree(frontend_stage, ignore_errors=True)

    if plugin_enabled(home) is not True:
        subprocess.run(
            ["hermes", "plugins", "enable", PLUGIN_ID, "--no-allow-tool-override"],
            check=True,
            env=environment,
        )
    print(f"Backend installed: {backend_root}")
    print(f"Desktop plugin installed: {frontend / 'plugin.js'}")
    print("Desktop renderer hot-reloads (fallback: ⌘K → Reload desktop plugins).")
    print("Restart the Hermes gateway/desktop once so the new Python backend is loaded.")


if __name__ == "__main__":
    main()
