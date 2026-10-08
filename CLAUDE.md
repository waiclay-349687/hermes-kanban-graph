# hermes-kanban-graph: Hermes Desktop 插件,以依赖图展示并编辑 Hermes Kanban 看板
TypeScript 5.9.2 + React (宿主提供) + @xyflow/react 12.11.2 + @dagrejs/dagre 3.0.0 + esbuild 0.25.9 + vitest 3.2.7 + Python/FastAPI (宿主 dashboard 进程)

<directory>
src/: Desktop 前端 (路由页、React Flow 画布、抽屉、纯图算法), 关键文件: plugin.tsx, ui.tsx, graph.ts
backend/dashboard/: dashboard 插件后端路由 (只读读取 + 委托核心写入)
tests/: vitest (graph.test.ts) 与 pytest (test_*.py)
</directory>

<config>
build.mjs: esbuild 打包,运行时只允许 import `@hermes/plugin-sdk`、`react`、`react/jsx-runtime`
backend/plugin.yaml: Hermes 插件清单 (版本)
backend/dashboard/manifest.json: dashboard 插件清单 (版本、api 入口)
install.py: 安装到 HERMES_HOME (编排方负责执行,开发中不要运行)
</config>

<commands>
typecheck: npm run typecheck
lint: (无)
test: npm test && env -u PYTHONPATH PYTHONPATH="$HOME/.hermes/hermes-agent" .venv/bin/python -m pytest -q
build: npm run build
verify: npm run verify (= test + typecheck + build) 以及上面的 pytest
</commands>

<compatibility>
- 宿主 SDK 是 blob shim 模块: 可能缺失的导出 (WorkspacePageHeaderControl、pluginSettingsHref、useQueryClient) 必须经 `import * as sdk` 特性检测,禁止具名导入,否则整个插件链接失败
- 只读宿主状态 (核心 Kanban 的 boardSlug、插件启用决策 localStorage),从不写入
- 不修改宿主仓库,不触碰真实 Kanban 数据; task_links 永远只读
- 后端写入委托核心处理器,核心缺失时 503,不运行分叉逻辑
</compatibility>
