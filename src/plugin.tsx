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
  useValue,
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
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  applyPositionOverrides,
  EMPTY_FILTERS,
  filterGraph,
  FOLLOW_KANBAN,
  isTaskNode,
  kanbanBoardStorageKey,
  layoutGraph,
  parseStoredSlug,
  resolveBoardSelection,
  statusBreakdown,
  statusMeta,
  summarizeGraph,
  UNLINKED_SECTION_ID,
  unmetParentCounts,
  type GraphFilters,
  type GraphNode,
  type GraphPayload,
  type GraphTask,
  type PositionOverrides,
  type TaskDetail
} from './graph'
import { LOCALES } from './i18n'
import pluginCss from './plugin.css'
import {
  BoardSwitcher,
  EDGE_TYPES,
  FilterMenu,
  GraphSettings,
  Inspector,
  NODE_TYPES,
  PLUGIN_ID,
  RefreshButton,
  StatusChips,
  statusLabel,
  useT,
  type BoardMeta,
  type ViewSettings
} from './ui'

interface BoardsResponse {
  current: string
  boards: BoardMeta[]
}

let api: null | PluginContext['rest'] = null
let pluginStorage: null | PluginContext['storage'] = null
let translate: null | PluginContext['i18n']['t'] = null
const CACHE_SCHEMA_VERSION = 3
const LOCAL_SCOPE = 'local'
const DEFAULT_VIEW_SETTINGS: ViewSettings = { direction: 'LR', edgeStyle: 'elbow', hideImplied: false, showGrid: true, showMiniMap: true, showMotion: true }
const GRAPH_ROUTE = '/kanban-graph'
const GRAPH_POLL_MS = 10_000
const KANBAN_FOLLOW_POLL_MS = 2_000
const FIT_OPTIONS = { padding: 0.16, maxZoom: 1.1 }
type PositionLayouts = Record<string, PositionOverrides>
const EMPTY_POSITIONS: PositionOverrides = {}
interface LiveNodes {
  context: string
  signature: string
  nodes: GraphNode[]
}

function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error')
  const brace = raw.indexOf('{')
  if (brace !== -1) {
    try {
      const detail = (JSON.parse(raw.slice(brace)) as { detail?: unknown }).detail
      if (typeof detail === 'string' && detail) return detail
    } catch {
      // Not JSON — keep the raw message.
    }
  }
  return raw
}

const scopedKey = (key: string, scope: string) => (scope === LOCAL_SCOPE ? key : `${key}.${scope}`)

function loadViewSettings(): ViewSettings {
  const saved = pluginStorage?.get<Partial<ViewSettings>>('view-settings', DEFAULT_VIEW_SETTINGS) ?? DEFAULT_VIEW_SETTINGS
  return {
    direction: saved.direction === 'TB' ? 'TB' : 'LR',
    edgeStyle: saved.edgeStyle === 'straight' || saved.edgeStyle === 'curve' ? saved.edgeStyle : 'elbow',
    showGrid: saved.showGrid !== false,
    showMiniMap: saved.showMiniMap !== false,
    showMotion: saved.showMotion !== false,
    hideImplied: saved.hideImplied === true
  }
}

function loadBoardSelection(scope: string): string {
  const saved = pluginStorage?.get<unknown>(scopedKey('board-selection', scope), FOLLOW_KANBAN)
  return typeof saved === 'string' && saved ? saved : FOLLOW_KANBAN
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

function readKanbanBoardSlug(scope: string): string {
  try {
    return parseStoredSlug(window.localStorage.getItem(kanbanBoardStorageKey(scope)))
  } catch {
    return ''
  }
}

/**
 * The bundled Kanban plugin keeps its selected board in its own plugin storage
 * and exposes no API for it. Read (never write) that persisted value so "Follow
 * Kanban" shows the same board as the Kanban page. Cheap localStorage reads on
 * a short interval plus focus/visibility catch in-window changes.
 */
function useKanbanBoardSlug(scope: string): string {
  const [slug, setSlug] = useState(() => readKanbanBoardSlug(scope))
  useEffect(() => {
    const sync = () => setSlug(readKanbanBoardSlug(scope))
    sync()
    const timer = window.setInterval(sync, KANBAN_FOLLOW_POLL_MS)
    window.addEventListener('focus', sync)
    window.addEventListener('storage', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', sync)
      window.removeEventListener('storage', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [scope])
  return slug
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
function installSidebarToggle(navLabel: () => string) {
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
    if (!button || button.textContent?.trim() !== navLabel()) return

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

function TaskInspectorController({ board, children, onClose, onOpenKanban, onRefresh, onSelect, parents, scope, task }: {
  board: string
  children: GraphTask[]
  onClose: () => void
  onOpenKanban: () => void
  onRefresh: () => Promise<unknown>
  onSelect: (task: GraphTask) => void
  parents: GraphTask[]
  scope: string
  task: GraphTask
}) {
  const t = useT()
  const [savingContent, setSavingContent] = useState(false)
  const [savingComment, setSavingComment] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<string | null>(null)
  const taskPath = `/tasks/${encodeURIComponent(task.id)}?board=${encodeURIComponent(board)}`
  const detailQuery = useQuery<TaskDetail>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'task', board, task.id],
    queryFn: () => api!(taskPath),
    refetchInterval: GRAPH_POLL_MS
  })

  const refresh = async () => {
    await Promise.all([detailQuery.refetch(), onRefresh()])
  }
  const saveContent = async (patch: { title?: string; body?: string }) => {
    setSavingContent(true)
    try {
      await api!(taskPath, { method: 'PATCH', body: patch })
      await refresh()
      host?.notify({ kind: 'success', message: t('toast.updated') })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: t('toast.updateFailed', errText(error)) })
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
      host?.notify({ kind: 'success', message: t('toast.commented') })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: t('toast.commentFailed', errText(error)) })
      return false
    } finally {
      setSavingComment(false)
    }
  }
  const changeStatus = async (status: string, summary?: string) => {
    const current = detailQuery.data?.task.status ?? task.status
    if (status === current) return true
    setPendingStatus(status)
    try {
      await api!(taskPath, { method: 'PATCH', body: summary ? { status, summary } : { status } })
      await refresh()
      host?.notify({ kind: 'success', message: t('toast.moved', statusLabel(t, status)) })
      return true
    } catch (error) {
      host?.notify({ kind: 'error', message: t('toast.moveFailed', errText(error)) })
      return false
    } finally {
      setPendingStatus(null)
    }
  }

  // Detail rows lack the graph-only fields (hidden link counts); keep them.
  const currentTask: GraphTask = detailQuery.data?.task
    ? { ...task, ...detailQuery.data.task, hidden_parent_count: task.hidden_parent_count, hidden_child_count: task.hidden_child_count }
    : task
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
  const t = useT()
  const scope = useValue(host.state.connectionId) ?? LOCAL_SCOPE
  const kanbanSlug = useKanbanBoardSlug(scope)
  const [selection, setSelection] = useState(() => loadBoardSelection(scope))
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<GraphFilters>(EMPTY_FILTERS)
  const [settings, setSettings] = useState<ViewSettings>(loadViewSettings)
  const [unlinkedCollapsed, setUnlinkedCollapsed] = useState(() => pluginStorage?.get<boolean>('unlinked-collapsed', false) === true)
  const [positionLayouts, setPositionLayouts] = useState<PositionLayouts>(loadPositionLayouts)
  const [liveNodes, setLiveNodes] = useState<LiveNodes>({ context: '', signature: '', nodes: [] })
  const flowRef = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const positionLayoutsRef = useRef(positionLayouts)
  const fitContextRef = useRef<string | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const restoreNodeIdRef = useRef<string | null>(null)

  // A different gateway has different boards: reload that connection's choice.
  useEffect(() => setSelection(loadBoardSelection(scope)), [scope])

  const boardsQuery = useQuery<BoardsResponse>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'boards'],
    queryFn: () => api!('/boards'),
    staleTime: 15_000,
    refetchInterval: 30_000
  })
  const availableBoards = useMemo(() => (boardsQuery.data?.boards ?? []).filter(item => !item.archived), [boardsQuery.data])
  const followedSlug = resolveBoardSelection({
    boards: availableBoards,
    kanbanSlug,
    selection: FOLLOW_KANBAN,
    serverCurrent: boardsQuery.data?.current ?? ''
  })
  const boardValue = resolveBoardSelection({
    boards: availableBoards,
    kanbanSlug,
    selection,
    serverCurrent: boardsQuery.data?.current ?? ''
  })
  const graphQuery = useQuery<GraphPayload>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'graph', boardValue, includeArchived],
    queryFn: () => api!(`/graph?board=${encodeURIComponent(boardValue)}&include_archived=${includeArchived}`),
    enabled: Boolean(boardValue),
    refetchInterval: GRAPH_POLL_MS
  })
  const positionContext = boardValue
    ? (scope === LOCAL_SCOPE ? `${boardValue}:${settings.direction}` : `${scope}:${boardValue}:${settings.direction}`)
    : ''
  const positionOverrides = positionContext ? positionLayouts[positionContext] ?? EMPTY_POSITIONS : EMPTY_POSITIONS

  const payload = boardValue && graphQuery.data?.board.slug === boardValue ? graphQuery.data : undefined
  const selected = useMemo(() => payload?.nodes.find(task => task.id === selectedId) ?? null, [payload, selectedId])
  const filtered = useMemo(() => payload ? filterGraph(payload, filters) : null, [payload, filters])
  const decorated = useMemo(() => {
    if (!filtered || !payload) return null
    const counts = new Map<string, number>()
    for (const edge of filtered.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
    }
    // Unmet prerequisites come from the full board, not the filtered view.
    const unmet = unmetParentCounts(payload)
    return {
      ...filtered,
      nodes: filtered.nodes.map(task => ({ ...task, _linkCount: counts.get(task.id) ?? 0, _unmet: unmet.get(task.id) ?? 0 }))
    }
  }, [filtered, payload])
  const autoElements = useMemo(
    () => decorated
      ? layoutGraph(decorated, settings.direction, settings.edgeStyle, settings.showMotion, { hideImplied: settings.hideImplied, unlinkedCollapsed })
      : { nodes: [], edges: [], linkedCount: 0, unlinkedCount: 0, impliedCount: 0 },
    [decorated, settings.direction, settings.edgeStyle, settings.hideImplied, settings.showMotion, unlinkedCollapsed]
  )
  const positionedNodes = useMemo(
    () => applyPositionOverrides(autoElements.nodes, positionOverrides),
    [autoElements, positionOverrides]
  )
  const nodeSignature = useMemo(() => positionedNodes.map(node => node.id).join('\u0000'), [positionedNodes])
  const displayedNodes = liveNodes.context === positionContext && liveNodes.signature === nodeSignature
    ? liveNodes.nodes
    : positionedNodes
  const stats = useMemo(() => filtered ? summarizeGraph(filtered) : null, [filtered])
  const chips = useMemo(() => statusBreakdown(payload?.nodes ?? []), [payload])
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

  const toggleUnlinked = useCallback(() => {
    setUnlinkedCollapsed(current => {
      pluginStorage?.set('unlinked-collapsed', !current)
      return !current
    })
  }, [])
  const activateNode = useCallback((id: string) => {
    if (id === UNLINKED_SECTION_ID) toggleUnlinked()
    else setSelectedId(id)
  }, [toggleUnlinked])
  // One stable handler for every node keeps memoized cards from re-rendering.
  const onNodeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const id = event.currentTarget.dataset.id
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    activateNode(id)
  }, [activateNode])

  const focusedNodes = useMemo(() => displayedNodes.map(node => {
    if (!isTaskNode(node)) {
      return { ...node, ariaLabel: t(node.data.collapsed ? 'section.expand' : 'section.collapse'), deletable: false, domAttributes: { onKeyDownCapture: onNodeKeyDown } }
    }
    return {
      ...node,
      ariaLabel: t('node.open', String(node.data.title || node.id)),
      className: selectedId ? (relatedIds.has(node.id) ? 'hkg-node-related' : 'hkg-node-dimmed') : node.className,
      deletable: false,
      domAttributes: { onKeyDownCapture: onNodeKeyDown },
      selected: node.id === selectedId
    }
  }) as GraphNode[], [displayedNodes, onNodeKeyDown, relatedIds, selectedId, t])
  const focusedEdges = useMemo(() => autoElements.edges.map(edge => ({
    ...edge,
    className: selectedId ? (edge.source === selectedId || edge.target === selectedId ? 'hkg-edge-related' : 'hkg-edge-dimmed') : edge.className,
    deletable: false,
    zIndex: selectedId && (edge.source === selectedId || edge.target === selectedId) ? 2 : 0
  })), [autoElements.edges, selectedId])

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
  const fitView = () => void flowRef.current?.fitView({ ...FIT_OPTIONS, duration: 220 })
  const onNodesChange = (changes: NodeChange<GraphNode>[]) => {
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
  const persistNodePosition = (node: GraphNode) => {
    if (!positionContext || !isTaskNode(node)) return
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
  const chooseBoard = (next: string) => {
    setSelection(next)
    setSelectedId(null)
    pluginStorage?.set(scopedKey('board-selection', scope), next)
  }
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS)
    setIncludeArchived(false)
  }
  const selectRelationship = (task: GraphTask) => {
    setFilters(EMPTY_FILTERS)
    if (task.status === 'archived') setIncludeArchived(true)
    if (unlinkedCollapsed) toggleUnlinked()
    setSelectedId(task.id)
  }
  const hasFilters = Boolean(filters.query || filters.status || filters.assignee || filters.tenant || filters.linkedOnly || includeArchived)
  const inspectorOpen = Boolean(selectedId)
  const loadError = (!boardsQuery.data && boardsQuery.error) || (!payload && graphQuery.error)
  const loading = boardsQuery.isLoading || (Boolean(boardValue) && !payload && !graphQuery.error)
  const archivedHidden = !includeArchived ? payload?.archived_count ?? 0 : 0

  useEffect(() => pluginStorage?.set('view-settings', settings), [settings])
  useEffect(() => {
    setLiveNodes(current => {
      const previous = current.context === positionContext
        ? new Map(current.nodes.map(node => [node.id, node]))
        : new Map<string, GraphNode>()
      return {
        context: positionContext,
        signature: nodeSignature,
        nodes: positionedNodes.map(node => {
          const prior = previous.get(node.id)
          return prior?.measured ? { ...node, measured: prior.measured } as GraphNode : node
        })
      }
    })
  }, [nodeSignature, positionContext, positionedNodes])
  useEffect(() => {
    if (!payload || focusedNodes.length === 0) return
    const context = `${scope}:${payload.board.slug}:${settings.direction}`
    const previous = fitContextRef.current
    fitContextRef.current = context
    if (previous === null || previous === context) return
    const frame = requestAnimationFrame(() => {
      void flowRef.current?.fitView({ ...FIT_OPTIONS, duration: 220 })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedNodes.length, payload?.board.slug, scope, settings.direction])
  useEffect(() => {
    if (!selectedId || !filtered) return
    const visible = filtered.nodes.some(task => task.id === selectedId) && displayedNodes.some(node => node.id === selectedId)
    if (!visible) setSelectedId(null)
  }, [displayedNodes, filtered, selectedId])
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
        document.querySelector<HTMLElement>('.hkg-inspector-head-actions button:last-child')?.focus()
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

  const renderEmpty = () => {
    if (hasFilters) {
      return <div className="hkg-state"><EmptyState description={t('state.noMatchHint')} title={t('state.noMatch')} /><Button onClick={clearFilters} size="sm" variant="outline">{t('state.clearFilters')}</Button></div>
    }
    if (payload?.board.initialized === false) {
      return <div className="hkg-state"><EmptyState description={t('state.notInitializedHint')} title={t('state.notInitialized')} /><Button onClick={() => host.navigate('/kanban')} size="sm" variant="outline">{t('state.openKanban')}</Button></div>
    }
    if (archivedHidden > 0) {
      return <div className="hkg-state"><EmptyState description={t('state.allArchivedHint')} title={t('state.allArchived', archivedHidden)} /><Button onClick={() => setIncludeArchived(true)} size="sm" variant="outline">{t('state.showArchived')}</Button></div>
    }
    return <div className="hkg-state"><EmptyState description={t('state.emptyHint')} title={t('state.empty')} /><Button onClick={() => host.navigate('/kanban')} size="sm" variant="outline">{t('state.openKanban')}</Button></div>
  }

  return (
    <main className="hkg-root">
      <Contribute area={TITLEBAR_AREAS.center} id="kanban-graph:board-switcher">
        <BoardSwitcher boards={availableBoards} followedSlug={followedSlug} onChange={chooseBoard} selection={selection} />
      </Contribute>
      <header className="hkg-toolbar">
        <h1>{t('title')}</h1>
        <span className="hkg-count">{filtered?.nodes.length ?? payload?.nodes.length ?? 0}</span>
        <FilterMenu assignees={assignees} filters={filters} includeArchived={includeArchived} onArchived={setIncludeArchived} onChange={patchFilters} tenants={tenants} />
        <SearchField aria-label={t('toolbar.filterTasks')} className="hkg-search" onChange={(value: string) => patchFilters({ query: value })} placeholder={t('toolbar.filterTasks')} value={filters.query} />
        <StatusChips active={filters.status} counts={chips} onToggle={status => patchFilters({ status: filters.status === status ? '' : status })} />
        <div className="hkg-spacer" />
        {archivedHidden > 0 && (
          <button className="hkg-archived-hint" onClick={() => setIncludeArchived(true)} type="button">
            <Codicon name="archive" size="0.7rem" />{t('state.archivedHidden', archivedHidden)}
          </button>
        )}
        {stats && <Tip label={t('toolbar.statTip', stats.total, stats.linked, stats.isolated)}><span className="hkg-stat"><Codicon name="references" size="0.7rem" />{stats.linked}<span>·</span>{t('toolbar.unlinkedShort', stats.isolated)}</span></Tip>}
        <GraphSettings
          hasManualPositions={Object.keys(positionOverrides).length > 0}
          onChange={patchSettings}
          onFit={fitView}
          onResetPositions={resetNodePositions}
          settings={settings}
        />
        <RefreshButton onRefresh={() => { void graphQuery.refetch(); void boardsQuery.refetch() }} refreshing={graphQuery.isFetching} />
      </header>
      {payload?.truncated && <div className="hkg-banner"><Codicon name="warning" size="0.75rem" />{t('state.truncated', payload.nodes.length)}</div>}
      <section className="hkg-canvas">
        {loadError ? (
          <div className="hkg-state"><ErrorState description={errText(loadError)} title={t('state.loadError')} /><Button onClick={() => void (boardsQuery.error ? boardsQuery.refetch() : graphQuery.refetch())} size="sm" variant="outline">{t('state.retry')}</Button></div>
        ) : loading ? (
          <div className="hkg-state"><Loader type="lemniscate-bloom" /></div>
        ) : focusedNodes.length === 0 ? renderEmpty() : (
          <ReactFlow<GraphNode>
            deleteKeyCode={null}
            edgeTypes={EDGE_TYPES}
            edges={focusedEdges}
            edgesFocusable={false}
            fitView
            fitViewOptions={FIT_OPTIONS}
            maxZoom={1.6}
            minZoom={0.12}
            nodes={focusedNodes}
            nodesConnectable={false}
            nodesDraggable
            nodeTypes={NODE_TYPES}
            onNodeDragStop={(_event, node) => persistNodePosition(node)}
            onNodeClick={(_event, node) => activateNode(node.id)}
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
            {settings.showMiniMap && (
              <MiniMap
                nodeColor={node => (isTaskNode(node as GraphNode) ? statusMeta(String((node as GraphNode).data.status)).tone : 'transparent')}
                nodeStrokeWidth={2}
                pannable
                position="bottom-right"
                zoomable
              />
            )}
          </ReactFlow>
        )}
        {focusedNodes.length > 0 && <div className="hkg-canvas-hint"><span>{t('canvas.linked', stats?.linked ?? 0)}</span><span>{t('canvas.hint')}</span></div>}
        {selected && (
          <TaskInspectorController
            key={`${boardValue}:${selected.id}`}
            board={boardValue}
            children={relationships.children}
            onClose={() => setSelectedId(null)}
            onOpenKanban={() => host.navigate('/kanban')}
            onRefresh={() => graphQuery.refetch()}
            onSelect={selectRelationship}
            parents={relationships.parents}
            scope={scope}
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

const navLabel = () => translate?.('nav') || 'Kanban Graph'

export default {
  id: PLUGIN_ID,
  name: 'Kanban Graph',
  defaultEnabled: true,
  register(ctx: PluginContext) {
    api = ctx.rest.bind(ctx)
    pluginStorage = ctx.storage
    const disposeI18n = ctx.i18n?.register ? ctx.i18n.register(LOCALES) : () => {}
    translate = ctx.i18n?.t ?? null
    const disposeStyles = installStyles()
    const disposeSidebarToggle = installSidebarToggle(navLabel)
    const disposeApi = () => {
      api = null
      pluginStorage = null
      translate = null
    }
    ctx.onDispose(disposeStyles)
    ctx.onDispose(disposeSidebarToggle)
    ctx.onDispose(disposeApi)
    ctx.onDispose(disposeI18n)
    const registerLabels = () => ctx.registerMany([
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 50, data: { codicon: 'type-hierarchy-sub', label: navLabel(), path: GRAPH_ROUTE } },
      { id: 'palette', area: PALETTE_AREA, data: { id: 'kanban-graph.open', label: translate?.('paletteOpen') || 'Open Kanban Graph', keywords: ['kanban', 'task', 'graph', 'dependencies', 'dag', '看板', '依赖'], run: () => host.navigate(GRAPH_ROUTE) } }
    ])
    try {
      ctx.registerMany([
        { id: 'route', area: ROUTES_AREA, data: { path: GRAPH_ROUTE }, render: () => <GraphPage /> }
      ])
      let disposeLabels = registerLabels()
      ctx.i18n?.onLocaleChange?.(() => {
        disposeLabels()
        disposeLabels = registerLabels()
      })
    } catch (error) {
      disposeStyles()
      disposeSidebarToggle()
      disposeApi()
      disposeI18n()
      throw error
    }
  }
}
