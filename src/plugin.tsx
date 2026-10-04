import {
  Button,
  Codicon,
  Contribute,
  EmptyState,
  ErrorState,
  host,
  Loader,
  PALETTE_AREA,
  ROUTES_AREA,
  SearchField,
  SIDEBAR_NAV_AREA,
  Tip,
  TITLEBAR_AREAS,
  useQuery,
  type PluginContext
} from '@hermes/plugin-sdk'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import flowCss from '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  applyPositionOverrides,
  filterGraph,
  layoutGraph,
  summarizeGraph,
  type GraphFilters,
  type GraphPayload,
  type GraphTask,
  type PositionOverrides,
  type TaskDetail,
  type TaskNode
} from './graph'
import pluginCss from './plugin.css'
import { BoardSwitcher, EDGE_TYPES, FilterMenu, GraphSettings, Inspector, NODE_TYPES, RefreshButton, type BoardMeta, type ViewSettings } from './ui'

interface BoardsResponse {
  current: string
  boards: BoardMeta[]
}

let api: null | PluginContext['rest'] = null
let pluginStorage: null | PluginContext['storage'] = null
const CACHE_SCHEMA_VERSION = 2
const DEFAULT_VIEW_SETTINGS: ViewSettings = { direction: 'LR', edgeStyle: 'elbow', showGrid: true, showMiniMap: true, showMotion: true }
const GRAPH_ROUTE = '/kanban-graph'
const GRAPH_NAV_LABEL = 'Kanban Graph'
type PositionLayouts = Record<string, PositionOverrides>
const EMPTY_POSITIONS: PositionOverrides = {}
interface LiveNodes {
  context: string
  signature: string
  nodes: TaskNode[]
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function loadViewSettings(): ViewSettings {
  const saved = pluginStorage?.get<Partial<ViewSettings>>('view-settings', DEFAULT_VIEW_SETTINGS) ?? DEFAULT_VIEW_SETTINGS
  return {
    direction: saved.direction === 'TB' ? 'TB' : 'LR',
    edgeStyle: saved.edgeStyle === 'straight' || saved.edgeStyle === 'curve' ? saved.edgeStyle : 'elbow',
    showGrid: saved.showGrid !== false,
    showMiniMap: saved.showMiniMap !== false,
    showMotion: saved.showMotion !== false
  }
}

function loadBoardSelection(): string {
  const saved = pluginStorage?.get<unknown>('selected-board', '')
  return typeof saved === 'string' ? saved : ''
}

function loadPositionLayouts(): PositionLayouts {
  const saved = pluginStorage?.get<unknown>('node-positions', {})
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const layouts: PositionLayouts = {}
  for (const [context, rawPositions] of Object.entries(saved)) {
    if (!rawPositions || typeof rawPositions !== 'object' || Array.isArray(rawPositions)) continue
    const positions: PositionOverrides = {}
    for (const [taskId, rawPosition] of Object.entries(rawPositions)) {
      if (!rawPosition || typeof rawPosition !== 'object' || Array.isArray(rawPosition)) continue
      const position = rawPosition as { x?: unknown; y?: unknown }
      if (typeof position.x === 'number' && Number.isFinite(position.x) && typeof position.y === 'number' && Number.isFinite(position.y)) {
        positions[taskId] = { x: position.x, y: position.y }
      }
    }
    if (Object.keys(positions).length > 0) layouts[context] = positions
  }
  return layouts
}

function routeFromHash(hash = window.location.hash): string {
  const target = hash.startsWith('#') ? hash.slice(1) : hash
  const path = target.split(/[?#]/, 1)[0]
  return path?.startsWith('/') ? path : '/'
}

/**
 * sidebar.nav contributions are route-only in the current Desktop SDK: they
 * expose no click callback or toggle flag. Keep the workaround scoped to this
 * exact contribution and remove it on plugin disposal. The first navigation
 * records the originating page; clicking the active row returns there.
 */
function installSidebarToggle() {
  let lastPath = routeFromHash()
  let returnPath = lastPath === GRAPH_ROUTE
    ? pluginStorage?.get<string>('sidebar-return-route', '/') ?? '/'
    : lastPath

  const recordRoute = () => {
    const nextPath = routeFromHash()
    if (nextPath === GRAPH_ROUTE && lastPath !== GRAPH_ROUTE) {
      returnPath = lastPath
      pluginStorage?.set('sidebar-return-route', returnPath)
    } else if (nextPath !== GRAPH_ROUTE) {
      returnPath = nextPath
    }
    lastPath = nextPath
  }

  const toggleActiveRow = (event: MouseEvent) => {
    if (routeFromHash() !== GRAPH_ROUTE || !(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('button[data-sidebar="menu-button"]')
    if (!button || button.textContent?.trim() !== GRAPH_NAV_LABEL) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    host.navigate(returnPath && returnPath !== GRAPH_ROUTE ? returnPath : '/')
  }

  window.addEventListener('hashchange', recordRoute)
  document.addEventListener('click', toggleActiveRow, true)
  return () => {
    window.removeEventListener('hashchange', recordRoute)
    document.removeEventListener('click', toggleActiveRow, true)
  }
}

function TaskInspectorController({ board, children, onClose, onOpenKanban, onRefresh, onSelect, parents, task }: {
  board: string
  children: GraphTask[]
  onClose: () => void
  onOpenKanban: () => void
  onRefresh: () => Promise<unknown>
  onSelect: (task: GraphTask) => void
  parents: GraphTask[]
  task: GraphTask
}) {
  const [savingContent, setSavingContent] = useState(false)
  const [savingComment, setSavingComment] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<string | null>(null)
  const detailQuery = useQuery<TaskDetail>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, 'task', board, task.id],
    queryFn: () => api!(`/tasks/${encodeURIComponent(task.id)}?board=${encodeURIComponent(board)}`),
    refetchInterval: 10_000
  })

  const refresh = async () => {
    await Promise.all([detailQuery.refetch(), onRefresh()])
  }
  const saveContent = async (patch: { title?: string; body?: string }) => {
    setSavingContent(true)
    try {
      await api!(`/tasks/${encodeURIComponent(task.id)}?board=${encodeURIComponent(board)}`, {
        method: 'PATCH',
        body: patch
      })
      await refresh()
      host?.notify({ kind: 'success', message: 'Task updated in Kanban.' })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: `Could not update task: ${errText(error)}` })
      return false
    } finally {
      setSavingContent(false)
    }
  }
  const addComment = async (body: string) => {
    setSavingComment(true)
    try {
      await api!(`/tasks/${encodeURIComponent(task.id)}/comments?board=${encodeURIComponent(board)}`, {
        method: 'POST',
        body: { body }
      })
      await refresh()
      host?.notify({ kind: 'success', message: 'Comment added. The Kanban worker can see this note.' })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: `Could not add comment: ${errText(error)}` })
      return false
    } finally {
      setSavingComment(false)
    }
  }
  const changeStatus = async (status: string) => {
    const current = detailQuery.data?.task.status ?? task.status
    if (status === current) return true
    setPendingStatus(status)
    try {
      await api!(`/tasks/${encodeURIComponent(task.id)}?board=${encodeURIComponent(board)}`, {
        method: 'PATCH',
        body: { status }
      })
      await refresh()
      host?.notify({ kind: 'success', message: `Task moved to ${status}.` })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: `Could not change status: ${errText(error)}` })
      return false
    } finally {
      setPendingStatus(null)
    }
  }

  const currentTask = detailQuery.data?.task ?? task
  const displayedTask = pendingStatus ? { ...currentTask, status: pendingStatus } : currentTask

  return (
    <Inspector
      children={children}
      comments={detailQuery.data?.comments ?? []}
      detailError={detailQuery.error ? errText(detailQuery.error) : ''}
      detailLoading={detailQuery.isLoading}
      detailReady={!detailQuery.error && Boolean(detailQuery.data)}
      events={detailQuery.data?.events ?? []}
      onAddComment={addComment}
      onChangeStatus={changeStatus}
      onClose={onClose}
      onOpenKanban={onOpenKanban}
      onRetry={() => void detailQuery.refetch()}
      onSaveContent={saveContent}
      onSelect={onSelect}
      parents={parents}
      savingComment={savingComment}
      savingContent={savingContent}
      savingStatus={pendingStatus !== null}
      task={displayedTask}
    />
  )
}

function GraphPage() {
  const [board, setBoard] = useState(loadBoardSelection)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<GraphFilters>({ query: '', status: '', assignee: '', tenant: '', linkedOnly: false })
  const [settings, setSettings] = useState<ViewSettings>(loadViewSettings)
  const [positionLayouts, setPositionLayouts] = useState<PositionLayouts>(loadPositionLayouts)
  const [liveNodes, setLiveNodes] = useState<LiveNodes>({ context: '', signature: '', nodes: [] })
  const flowRef = useRef<ReactFlowInstance<TaskNode> | null>(null)
  const positionLayoutsRef = useRef(positionLayouts)
  const fitContextRef = useRef<string | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const restoreNodeIdRef = useRef<string | null>(null)

  const boardsQuery = useQuery<BoardsResponse>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, 'boards'],
    queryFn: () => api!('/boards'),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const availableBoards = useMemo(() => (boardsQuery.data?.boards ?? []).filter(item => !item.archived), [boardsQuery.data])
  const boardValue = availableBoards.some(item => item.slug === board)
    ? board
    : availableBoards.find(item => item.slug === boardsQuery.data?.current)?.slug || availableBoards[0]?.slug || ''
  const graphQuery = useQuery<GraphPayload>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, 'graph', boardValue, includeArchived],
    queryFn: () => api!(`/graph?board=${encodeURIComponent(boardValue)}&include_archived=${includeArchived}`),
    refetchInterval: 10_000
  })
  const positionContext = boardValue ? `${boardValue}:${settings.direction}` : ''
  const positionOverrides = positionContext ? positionLayouts[positionContext] ?? EMPTY_POSITIONS : EMPTY_POSITIONS

  const payload = graphQuery.data
  const selected = useMemo(() => payload?.nodes.find(task => task.id === selectedId) ?? null, [payload, selectedId])
  const filtered = useMemo(() => payload ? filterGraph(payload, filters) : null, [payload, filters])
  const graphWithLinkCounts = useMemo(() => {
    if (!filtered) return null
    const counts = new Map<string, number>()
    for (const edge of filtered.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
    }
    return { ...filtered, nodes: filtered.nodes.map(task => ({ ...task, _linkCount: counts.get(task.id) ?? 0 })) }
  }, [filtered])
  const autoElements = useMemo(
    () => graphWithLinkCounts ? layoutGraph(graphWithLinkCounts, settings.direction, settings.edgeStyle, settings.showMotion) : { nodes: [], edges: [] },
    [graphWithLinkCounts, settings.direction, settings.edgeStyle, settings.showMotion]
  )
  const positionedNodes = useMemo(
    () => applyPositionOverrides(autoElements.nodes, positionOverrides),
    [autoElements, positionOverrides]
  )
  const nodeSignature = useMemo(() => positionedNodes.map(node => node.id).join('\u0000'), [positionedNodes])
  const displayedNodes = liveNodes.context === positionContext && liveNodes.signature === nodeSignature
    ? liveNodes.nodes
    : positionedNodes
  const elements = { ...autoElements, nodes: displayedNodes }
  const stats = useMemo(() => filtered ? summarizeGraph(filtered) : null, [filtered])
  const assignees = useMemo(() => [...new Set((payload?.nodes ?? []).map(node => node.assignee).filter(Boolean) as string[])].sort(), [payload])
  const tenants = useMemo(() => [...new Set((payload?.nodes ?? []).map(node => node.tenant).filter(Boolean) as string[])].sort(), [payload])

  const relatedIds = useMemo(() => {
    const related = new Set(selectedId ? [selectedId] : [])
    if (selectedId) {
      for (const edge of autoElements.edges) {
        if (edge.source === selectedId) related.add(edge.target)
        if (edge.target === selectedId) related.add(edge.source)
      }
    }
    return related
  }, [autoElements.edges, selectedId])
  const focusedNodes = useMemo(() => elements.nodes.map(node => ({
    ...node,
    ariaLabel: `Open task details: ${String(node.data.title || node.id)}`,
    className: selectedId ? (relatedIds.has(node.id) ? 'hkg-node-related' : 'hkg-node-dimmed') : node.className,
    deletable: false,
    domAttributes: {
      ...node.domAttributes,
      onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        setSelectedId(node.id)
      }
    },
    selected: node.id === selectedId
  })), [elements.nodes, relatedIds, selectedId])
  const focusedEdges = useMemo(() => autoElements.edges.map(edge => ({
    ...edge,
    className: selectedId ? (edge.source === selectedId || edge.target === selectedId ? 'hkg-edge-related' : 'hkg-edge-dimmed') : edge.className,
    deletable: false,
    zIndex: selectedId && (edge.source === selectedId || edge.target === selectedId) ? 2 : 0
  })), [autoElements.edges, selectedId])
  const focused = { nodes: focusedNodes, edges: focusedEdges }

  const relationships = useMemo(() => {
    if (!payload || !selected) return { parents: [], children: [] }
    const byId = new Map(payload.nodes.map(task => [task.id, task]))
    return {
      parents: payload.edges.filter(edge => edge.target === selected.id).flatMap(edge => byId.get(edge.source) ?? []),
      children: payload.edges.filter(edge => edge.source === selected.id).flatMap(edge => byId.get(edge.target) ?? [])
    }
  }, [payload, selected])

  const patchFilters = (patch: Partial<GraphFilters>) => setFilters(current => ({ ...current, ...patch }))
  const patchSettings = (patch: Partial<ViewSettings>) => setSettings(current => ({ ...current, ...patch }))
  const fitView = () => void flowRef.current?.fitView({ padding: 0.16, maxZoom: 1.1, duration: 220 })
  const onNodesChange = (changes: NodeChange<TaskNode>[]) => {
    if (!positionContext) return
    setLiveNodes(current => ({
      context: positionContext,
      signature: nodeSignature,
      nodes: applyNodeChanges(
        changes,
        current.context === positionContext && current.signature === nodeSignature ? current.nodes : positionedNodes
      )
    }))
  }
  const persistNodePosition = (node: TaskNode) => {
    if (!positionContext) return
    const current = positionLayoutsRef.current
    const next = {
      ...current,
      [positionContext]: {
        ...(current[positionContext] ?? {}),
        [node.id]: { x: node.position.x, y: node.position.y }
      }
    }
    positionLayoutsRef.current = next
    setPositionLayouts(next)
    pluginStorage?.set('node-positions', next)
  }
  const resetNodePositions = () => {
    if (!positionContext) return
    setPositionLayouts(current => {
      if (!(positionContext in current)) return current
      const next = { ...current }
      delete next[positionContext]
      positionLayoutsRef.current = next
      pluginStorage?.set('node-positions', next)
      return next
    })
    requestAnimationFrame(fitView)
  }
  const clearFilters = () => {
    setFilters({ query: '', status: '', assignee: '', tenant: '', linkedOnly: false })
    setIncludeArchived(false)
  }
  const selectRelationship = (task: GraphTask) => {
    setFilters({ query: '', status: '', assignee: '', tenant: '', linkedOnly: false })
    setIncludeArchived(task.status === 'archived')
    setSelectedId(task.id)
  }
  const hasFilters = Boolean(filters.query || filters.status || filters.assignee || filters.tenant || filters.linkedOnly || includeArchived)
  const inspectorOpen = Boolean(selectedId)
  const loadError = (!boardsQuery.data && boardsQuery.error) || (!payload && graphQuery.error)
  const loading = boardsQuery.isLoading || (Boolean(boardValue) && graphQuery.isLoading)

  useEffect(() => pluginStorage?.set('view-settings', settings), [settings])
  useEffect(() => {
    setLiveNodes(current => {
      const previous = current.context === positionContext
        ? new Map(current.nodes.map(node => [node.id, node]))
        : new Map<string, TaskNode>()
      return {
        context: positionContext,
        signature: nodeSignature,
        nodes: positionedNodes.map(node => {
          const prior = previous.get(node.id)
          return prior?.measured ? { ...node, measured: prior.measured } : node
        })
      }
    })
  }, [nodeSignature, positionContext, positionedNodes])
  useEffect(() => {
    if (boardValue) pluginStorage?.set('selected-board', boardValue)
  }, [boardValue])
  useEffect(() => {
    if (!payload || elements.nodes.length === 0) return
    const context = `${payload.board.slug}:${settings.direction}`
    const previous = fitContextRef.current
    fitContextRef.current = context
    if (previous === null || previous === context) return
    const frame = requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.16, maxZoom: 1.1, duration: 220 })
    })
    return () => cancelAnimationFrame(frame)
  }, [elements.nodes.length, payload?.board.slug, settings.direction])
  useEffect(() => {
    if (selectedId && filtered && !filtered.nodes.some(task => task.id === selectedId)) setSelectedId(null)
  }, [filtered, selectedId])
  useEffect(() => {
    if (!inspectorOpen) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreNodeIdRef.current = restoreFocusRef.current?.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? null
    return () => {
      const fallbackNode = restoreNodeIdRef.current
        ? [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => node.dataset.id === restoreNodeIdRef.current)
        : null
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
      else fallbackNode?.focus()
      restoreFocusRef.current = null
      restoreNodeIdRef.current = null
    }
  }, [inspectorOpen])
  useEffect(() => {
    if (!selectedId) return
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !active.closest('.hkg-inspector')) {
        document.querySelector<HTMLElement>('.hkg-inspector [aria-label="Close details"]')?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId])
  useEffect(() => {
    if (!inspectorOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inspectorOpen])

  return (
    <main className="hkg-root">
      <Contribute area={TITLEBAR_AREAS.center} id="kanban-graph:board-switcher">
        <BoardSwitcher boards={availableBoards} onChange={slug => { setBoard(slug); setSelectedId(null) }} value={boardValue} />
      </Contribute>
      <header className="hkg-toolbar">
        <h1>Kanban Graph</h1>
        <span className="hkg-count">{filtered?.nodes.length ?? payload?.nodes.length ?? 0}</span>
        <FilterMenu assignees={assignees} filters={filters} includeArchived={includeArchived} onArchived={setIncludeArchived} onChange={patchFilters} tenants={tenants} />
        <SearchField aria-label="Filter tasks" className="hkg-search" onChange={(value: string) => patchFilters({ query: value })} placeholder="Filter tasks" value={filters.query} />
        <div className="hkg-spacer" />
        {stats && <Tip label={`${stats.total} tasks · ${stats.linked} linked · ${stats.isolated} unlinked`}><span className="hkg-stat"><Codicon name="references" size="0.7rem" />{stats.linked}<span>·</span>{stats.isolated} unlinked</span></Tip>}
        <GraphSettings
          hasManualPositions={Object.keys(positionOverrides).length > 0}
          onChange={patchSettings}
          onFit={fitView}
          onResetPositions={resetNodePositions}
          settings={settings}
        />
        <RefreshButton onRefresh={() => void graphQuery.refetch()} refreshing={graphQuery.isFetching} />
      </header>
      <section className="hkg-canvas">
        {loadError ? (
          <div className="hkg-state"><ErrorState description={errText(loadError)} title="Could not load dependency graph" /><Button onClick={() => void (boardsQuery.error ? boardsQuery.refetch() : graphQuery.refetch())} size="sm" variant="outline">Try again</Button></div>
        ) : loading ? (
          <div className="hkg-state"><Loader type="lemniscate-bloom" /></div>
        ) : focused.nodes.length === 0 ? (
          <div className="hkg-state"><EmptyState description={hasFilters ? 'Clear filters to see the full graph.' : 'Create tasks and dependencies in Kanban to populate this view.'} title={hasFilters ? 'No matching tasks' : 'No tasks to show'} />{hasFilters ? <Button onClick={clearFilters} size="sm" variant="outline">Clear filters</Button> : <Button onClick={() => host.navigate('/kanban')} size="sm" variant="outline">Open Kanban</Button>}</div>
        ) : (
          <ReactFlow<TaskNode>
            deleteKeyCode={null}
            edgeTypes={EDGE_TYPES}
            edges={focused.edges}
            edgesFocusable={false}
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 1.1 }}
            maxZoom={1.6}
            minZoom={0.12}
            nodes={focused.nodes}
            nodesConnectable={false}
            nodesDraggable
            nodeTypes={NODE_TYPES}
            onNodeDragStop={(_event, node) => persistNodePosition(node)}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            onNodesChange={onNodesChange}
            onInit={instance => { flowRef.current = instance }}
            onPaneClick={event => {
              setSelectedId(null)
              if (event.detail === 2) fitView()
            }}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: false }}
            zoomOnDoubleClick={false}
          >
            {settings.showGrid && <Background color="var(--ui-stroke-tertiary)" gap={22} size={1} variant={BackgroundVariant.Dots} />}
            <Controls position="bottom-left" showInteractive={false} />
            {settings.showMiniMap && <MiniMap nodeColor="var(--ui-accent)" nodeStrokeWidth={2} pannable position="bottom-right" zoomable />}
          </ReactFlow>
        )}
        {focused.nodes.length > 0 && <div className="hkg-canvas-hint"><span>{stats?.linked ?? 0} linked</span><span>Double-click canvas to fit</span></div>}
        {selected && (
          <TaskInspectorController
            key={selected.id}
            board={boardValue}
            children={relationships.children}
            onClose={() => setSelectedId(null)}
            onOpenKanban={() => host.navigate('/kanban')}
            onRefresh={() => graphQuery.refetch()}
            onSelect={selectRelationship}
            parents={relationships.parents}
            task={selected}
          />
        )}
      </section>
    </main>
  )
}

function installStyles() {
  document.querySelector('style[data-hermes-plugin="kanban-graph"]')?.remove()
  const style = document.createElement('style')
  style.dataset.hermesPlugin = 'kanban-graph'
  style.textContent = `${flowCss}\n${pluginCss}`
  document.head.append(style)
  return () => style.remove()
}

export default {
  id: 'kanban-graph',
  name: 'Kanban Graph',
  defaultEnabled: true,
  register(ctx: PluginContext) {
    api = ctx.rest.bind(ctx)
    pluginStorage = ctx.storage
    const disposeStyles = installStyles()
    const disposeSidebarToggle = installSidebarToggle()
    const disposeApi = () => {
      api = null
      pluginStorage = null
    }
    ctx.onDispose(disposeStyles)
    ctx.onDispose(disposeSidebarToggle)
    ctx.onDispose(disposeApi)
    try {
      ctx.registerMany([
        { id: 'route', area: ROUTES_AREA, data: { path: GRAPH_ROUTE }, render: () => <GraphPage /> },
        { id: 'nav', area: SIDEBAR_NAV_AREA, order: 50, data: { codicon: 'type-hierarchy-sub', label: GRAPH_NAV_LABEL, path: GRAPH_ROUTE } },
        { id: 'palette', area: PALETTE_AREA, data: { label: 'Open Kanban Graph', keywords: ['kanban', 'task', 'graph', 'dependencies', 'dag'], run: () => host.navigate(GRAPH_ROUTE) } }
      ])
    } catch (error) {
      disposeStyles()
      disposeSidebarToggle()
      disposeApi()
      throw error
    }
  }
}
