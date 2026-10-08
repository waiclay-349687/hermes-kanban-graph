# backend/dashboard/
> L2 | 父级: /CLAUDE.md

## 成员清单
plugin_api.py: FastAPI 路由 (挂载于 Hermes dashboard 插件命名空间),只读 SQLite 读取 (mode=ro + query_only + authorizer),写入一律委托核心 Kanban 后端的 `_board_conn` / `_patch_status` / `_patch_title_body` / `add_comment` / `dispatch`; `GET /workflow` 透传 `kanban_workflow.DEFAULT_WORKFLOW.to_dict()`
graph_data.py: 纯序列化,任务行 + 依赖行 → 图投影 (字段白名单, 5,000 节点上限, 归档隐藏与截断隐藏分开计数, `total_count`)
manifest.json: dashboard 插件清单 (name/version/api 入口)
__init__.py: 包标记

## 边界
本模块负责: 看板列表与计数、图投影、任务详情 (事件剔除 heartbeat、最多 50 条)、委托核心的状态/内容/评论写入与调度 nudge
本模块不负责: 依赖链接写入 (task_links 永远只读)、创建看板数据库、复制核心状态机逻辑
上游: hermes_cli.kanban_db, hermes_cli.kanban_workflow, plugins/kanban/dashboard/plugin_api.py (核心)
下游: src/plugin.tsx (经 ctx.rest)

## 约定
- 省略 `board` 时 `_resolve_board` 返回 None, 与核心一致, 让 `kanban_db_path(None)` 处理 `HERMES_KANBAN_DB` pin 与 fence
- 任何写入前 `_require_initialized`: 核心 `_board_conn` 会 init_db, 插件不得借此创建库
- 测试使用临时 `HERMES_KANBAN_HOME`; 调度测试必须 monkeypatch `core.kbd.dispatch_once`

[PROTOCOL]: 变更时更新此文件,然后检查父级 CLAUDE.md
