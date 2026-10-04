# Hermes Kanban Graph

A standalone Hermes Desktop plugin that renders the existing Kanban task graph and dependency DAG with React Flow and Dagre. It does not patch Hermes core or create a second task store: Hermes Kanban remains authoritative.

## Features

- Full-page native Desktop route at `/kanban-graph`
- React Flow pan, zoom, fit-view, minimap, draggable nodes, and accessible controls
- Dagre left-to-right or top-to-bottom layout
- Persistent Straight, Elbow, and Curve connection styles with low-saturation status gradients
- Semantic connection motion: running paths flow, blocked endpoints breathe, selected paths trace direction, and completed paths remain still and muted
- Multi-board selection
- Search and status/assignee/tenant/archive/linked-task filters
- Relationship focus with unrelated cards and edges dimmed
- Official Kanban-aligned task cards and detail drawer with status, title, and description editing plus comments, activity, results, and dependencies
- Clickable parent/child relationships inside the detail drawer
- Persistent MiniMap, dot-grid, layout, connection motion, connection preferences, and per-board manual node positions
- Hermes light/dark theme support
- Read-only graph/detail SQLite queries (`mode=ro`) plus narrowly scoped task-content, operator-controlled status, and comment writes
- 10-second React Query refresh fallback

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Python tests use a clean Python environment with `pytest` and `fastapi` available:

```bash
PYTHONPATH="$HOME/.hermes/hermes-agent" python -m pytest -q
```

## Install

```bash
python3 install.py
```

The installer honors `HERMES_HOME`, so an active Hermes profile receives both the backend and Desktop plugin in that profile. Existing plugin directories are replaced atomically to avoid stale bundle or source-map files.

Restart Hermes Desktop once so its Python backend mounts the new route. The plugin is enabled by default and appears as **Kanban Graph** in the sidebar; clicking its active sidebar row again returns to the page that opened it. It can still be disabled in Settings → Plugins.

## Architecture

- `backend/dashboard/plugin_api.py`: namespaced FastAPI graph/detail routes and whitelisted task-content/comment mutations
- `backend/dashboard/graph_data.py`: stable graph projection serializer
- `src/graph.ts`: pure filtering, statistics, and Dagre layout
- `src/plugin.tsx`: Hermes Desktop route and React Flow UI
- `src/ui.tsx`: Kanban-aligned cards, filters, graph settings, board switcher, and detail drawer
- `build.mjs`: bundles all third-party UI code while externalizing the host React and `@hermes/plugin-sdk`

The final runtime bundle is checked to contain no unsupported external imports.

## Safety

Graph, board, detail, and dependency reads open SQLite with URI `mode=ro` and `PRAGMA query_only=ON`. The only write routes are `PATCH /tasks/{id}` for `title`/`body` or an operator-controlled `status`, and `POST /tasks/{id}/comments` with a server-fixed author. System-owned states (`scheduled`, `running`, and `review`) cannot be selected manually. Status changes use the same completion, blocking, unblocking, archival, event, active-run, and dependency checks as the official Kanban. Gradients, motion, and connection geometry are display-only. There are no dependency-link write routes: `task_links` remains strictly read only.

## License

MIT. React Flow and Dagre are also MIT-licensed; their license comments are retained in the generated bundle.
