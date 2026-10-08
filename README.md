# Hermes Kanban Graph

A standalone Hermes Desktop plugin that renders the existing Kanban task graph and dependency DAG with React Flow and Dagre. It does not patch Hermes core or create a second task store: Hermes Kanban remains authoritative.

## How this differs from Senci/hermes-kanban-graph

[Senci/hermes-kanban-graph](https://github.com/Senci/hermes-kanban-graph) is an independent community plugin with the same name, built around the same time. It is a **read-only, all-boards** observatory with a live event stream, worker run history, deep links and a static HTML snapshot. Use it if that is what you need.

This plugin focuses on **working on one board inside the graph**:

- Edit status (only the moves core Kanban allows), title and description, and add comments, all delegated to core Kanban handlers.
- Follow the board selected on the Kanban page, or pin any other board.
- Drag cards and keep their positions per board, with filters for status, assignee, tenant, archived and linked-only.
- Chinese and English UI.

The two plugins are unrelated codebases, but **both use the plugin id `kanban-graph`**, so install only one of them. Installing one replaces the other's `plugins/kanban-graph` and `desktop-plugins/kanban-graph` directories.

## Features

- Full-page native Desktop route at `/kanban-graph`
- React Flow pan, zoom, fit-view, minimap, draggable nodes, and accessible controls
- Dagre left-to-right or top-to-bottom layout
- Persistent Straight, Elbow, and Curve connection styles with low-saturation status gradients
- Semantic connection motion: running paths flow, blocked endpoints breathe, selected paths trace direction, and completed paths remain still and muted
- Multi-board: **Follow Kanban** (default) shows whatever board the bundled Kanban page has selected (read from its persisted choice, per connection; a board just created there is picked up at once); or pin any board. Archived boards (and `boards/_archived/`) are ignored; the switcher shows open-task counts and sits in the workspace page header on hosts that support it
- Connection-safe: queries only run, and edits only send, while their cache scope is the connection requests are routed to, so switching gateways never mixes boards
- Unlinked tasks are not forced into a Dagre rank: they sit in a sorted grid under a collapsible **Unlinked tasks** header
- Links that are implied by a longer path are drawn faint and kept out of Dagre ranking; they can be hidden. Reachability is computed once per graph, so large boards have no edge-count cutoff
- Dagre only re-runs when the linked structure changes; status/summary updates, heartbeats and search typing do not re-layout, and a card being dragged is never reset by a refresh
- Status colours/icons identical to the Kanban board; per-status chips that filter; unmet-prerequisite, hidden (archived) and beyond-the-limit link badges, counted separately
- Empty states for uninitialized, fully archived, and filtered-out boards; boards over 5,000 tasks say how many are shown and that filters only cover those
- English and Simplified Chinese UI (follows the app locale)
- Search and status/assignee/tenant/archive/linked-task filters
- Relationship focus with unrelated cards and edges dimmed
- Official Kanban-aligned task cards and detail drawer with status, title, and description editing plus comments, activity (no heartbeats, newest 50 events), results, and dependencies
- The status menu offers only the moves core's workflow accepts from the current status (`GET /workflow`); completing a task that already has a result keeps it; a status change nudges the dispatcher like the Kanban board does
- Saving never discards newer input typed while the request was in flight; Escape cancels the editor or menu it was pressed in, and only closes the drawer otherwise
- **Open in Kanban** checks that the bundled Kanban page is enabled (it ships off) and names the board it will show when the graph is pinned to another one
- Clickable parent/child relationships inside the detail drawer
- Persistent MiniMap, dot-grid, layout, connection motion, connection preferences, and per-board manual node positions (kept only while a card stays linked/unlinked, pruned when tasks disappear, capped in size)
- Toggling **Show archived** keeps the canvas, zoom and pan, with a small updating indicator
- Hermes light/dark theme support
- Read-only graph/detail SQLite queries (`mode=ro` + `query_only` + a deny-all-writes authorizer); edits are delegated to the bundled Kanban backend
- Live updates: a WebSocket (`/events`, handed to the bundled Kanban backend's event stream with its own auth) refreshes the graph, and the open task when an event touched it, moments after a change; polling stays as a fallback at 60 seconds while the push is live and 10 seconds without it (OAuth remotes, older hosts), plus a 30-second open-task refresh; the refresh button also reloads the open task

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Python tests need `pytest`, `fastapi`, `python-multipart`, `ruamel.yaml`, and `pyyaml` (the repo's `.venv` has them). They run against a temporary `HERMES_KANBAN_HOME` and never touch real boards:

```bash
env -u PYTHONPATH PYTHONPATH="$HOME/.hermes/hermes-agent" .venv/bin/python -m pytest -q
```

`npm run audit` runs `npm audit` separately (network); `npm run verify` = tests + typecheck + build.

## Install

```bash
python3 install.py
```

The installer honors `HERMES_HOME`, so an active Hermes profile receives both the backend and Desktop plugin in that profile. Existing plugin directories are replaced atomically to avoid stale bundle or source-map files.

The Desktop renderer hot-reloads (fallback: ⌘K → **Reload desktop plugins**). Restart the Hermes gateway/Desktop once after a backend change so the new Python routes load. `config.yaml` is only touched when the plugin is not already enabled. The plugin is enabled by default and appears as **Kanban Graph** in the sidebar; clicking its active sidebar row again returns to the page that opened it. It can still be disabled in Settings → Plugins.

## Architecture

- `backend/dashboard/plugin_api.py`: namespaced FastAPI graph/detail routes and whitelisted task-content/comment mutations
- `backend/dashboard/graph_data.py`: stable graph projection serializer
- `src/graph.ts`: pure filtering, statistics, and Dagre layout
- `src/plugin.tsx`: Hermes Desktop route and React Flow UI
- `src/ui.tsx`: Kanban-aligned cards, filters, graph settings, board switcher, and detail drawer
- `build.mjs`: bundles all third-party UI code while externalizing the host React and `@hermes/plugin-sdk`

The final runtime bundle is checked to contain no unsupported external imports.

## Safety

An omitted `board` resolves exactly like core (`kanban_db_path(None)`), so a `HERMES_KANBAN_DB` pin and the worker fence apply the same way; there is no plugin-specific board lock.

Graph, board, detail, and dependency reads open SQLite with URI `mode=ro`, `PRAGMA query_only=ON`, and an authorizer that denies every non-read statement; a missing board database is reported, never created. The only write routes are `PATCH /tasks/{id}` for `title`/`body` or an operator-controlled `status` (plus an optional completion `summary`, which Kanban requires to mark a card done), `POST /tasks/{id}/comments` with a server-fixed author, and `POST /dispatch`, which calls core's dispatcher nudge with explicit arguments. System-owned states (`scheduled`, `running`, and `review`) cannot be selected manually. Status and content edits call the bundled Kanban dashboard's own handlers (`_patch_status`, `_patch_title_body`), and comments go through core's `_board_conn` + `kanban_db.add_comment`, so worker termination, forced completion, done/archived parent gating, descendant invalidation, and lifecycle hooks are identical to dragging a card on the board; if those handlers are missing the edit is refused (503) rather than run through divergent code. Gradients, motion, and connection geometry are display-only. There are no dependency-link write routes: `task_links` remains strictly read only.

## License

MIT. React Flow and Dagre are also MIT-licensed; their license comments are retained in the generated bundle.
