#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def resolve_hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def install_paths(home: Path) -> tuple[Path, Path]:
    return (
        home / "plugins" / "kanban-graph" / "dashboard",
        home / "desktop-plugins" / "kanban-graph",
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


def main() -> None:
    environment = os.environ.copy()
    home = resolve_hermes_home()
    environment["HERMES_HOME"] = str(home)
    backend, frontend = install_paths(home)
    backend_root = backend.parent
    backend_stage = backend_root.with_name(f".{backend_root.name}.staged-{os.getpid()}")
    frontend_stage = frontend.with_name(f".{frontend.name}.staged-{os.getpid()}")

    subprocess.run(["npm", "run", "verify"], cwd=ROOT, check=True, env=environment)
    shutil.rmtree(backend_stage, ignore_errors=True)
    shutil.rmtree(frontend_stage, ignore_errors=True)
    (backend_stage / "dashboard").mkdir(parents=True, exist_ok=True)
    frontend_stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "backend" / "plugin.yaml", backend_stage / "plugin.yaml")
    shutil.copy2(ROOT / "backend" / "__init__.py", backend_stage / "__init__.py")
    for name in ("manifest.json", "plugin_api.py", "graph_data.py"):
        shutil.copy2(ROOT / "backend" / "dashboard" / name, backend_stage / "dashboard" / name)
    shutil.copytree(ROOT / "backend" / "dashboard" / "dist", backend_stage / "dashboard" / "dist")
    shutil.copy2(ROOT / "dist" / "plugin.js", frontend_stage / "plugin.js")
    source_map = ROOT / "dist" / "plugin.js.map"
    if source_map.exists():
        shutil.copy2(source_map, frontend_stage / "plugin.js.map")
    _replace_directory(backend_stage, backend_root)
    _replace_directory(frontend_stage, frontend)
    subprocess.run(
        ["hermes", "plugins", "enable", "kanban-graph", "--no-allow-tool-override"],
        check=True,
        env=environment,
    )
    print(f"Backend installed: {backend}")
    print(f"Desktop plugin installed: {frontend / 'plugin.js'}")
    print("Restart Hermes Desktop to mount the backend route; the Desktop plugin is enabled by default.")


if __name__ == "__main__":
    main()
