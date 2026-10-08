import * as sdk from '@hermes/plugin-sdk'
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
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'

import {
  applyPositionOverrides,
  coreKanbanEnabled,
  DEFAULT_MANUAL_MOVES,
  EMPTY_FILTERS,
  filterGraph,
  FOLLOW_KANBAN,
  isTaskNode,
  kanbanBoardStorageKey,
  kanbanEnabledIn,
  keyInRoutedScope,
  layoutGraph,
  layoutLinked,
  parsePositionStore,
  parseStoredSlug,
  planLayout,
  PLUGIN_DECISIONS_KEY,
  prunePositions,
  resolveBoardSelection,
  savePosition,
  statusBreakdown,
  statusMeta,
  statusTargets,
  stripEventCursor,
  summarizeGraph,
  UNLINKED_SECTION_ID,
  unmetParentCounts,
  type GraphFilters,
  type GraphNode,
  type GraphPayload,
  type GraphTask,
  type ManualMoves,
  type PositionOverrides,
  type PositionStore,
  type TaskDetail
} from './graph'
import { LOCALES } from './i18n'
import { coalesce, EventCursors, eventsPath, frameEffect, graphPollMs, LIVE_COALESCE_MS, LIVE_LEASE_MS, touchesTask, type FrameEffect } from './live'
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

interface WorkflowResponse {
  manual?: Record<string, string[]>
}

let api: null | PluginContext['rest'] = null
let pluginStorage: null | PluginContext['storage'] = null
let translate: null | PluginContext['i18n']['t'] = null
// `ctx.socket` (newer hosts only): the live twin of `ctx.rest`. Null means the
// graph stays on its 10 s polling.
let openSocket: null | NonNullable<PluginContext['socket']> = null
const CACHE_SCHEMA_VERSION = 3
const LOCAL_SCOPE = 'local'
const DEFAULT_VIEW_SETTINGS: ViewSettings = { direction: 'LR', edgeStyle: 'elbow', hideImplied: false, showGrid: true, showMiniMap: true, showMotion: true }
const GRAPH_ROUTE = '/kanban-graph'
// Like core's drawer: the open task changes rarely and every edit refetches it.
const DETAIL_POLL_MS = 30_000
const KANBAN_FOLLOW_POLL_MS = 2_000
const DISPATCH_DEBOUNCE_MS = 400
const FIT_OPTIONS = { padding: 0.16, maxZoom: 1.1 }
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

// ── connection scope ─────────────────────────────────────────────────────────
//
// `ctx.rest` sends a request to the connection that is active *now*, which can
// move before `host.state.connectionId` publishes and before React re-keys the
// observers. A fetch from an observer still on the outgoing scope's key would
// then cache the incoming gateway's answer under the outgoing key and paint it
// on the way back. Like core Kanban's `routedToScope`, only fetch (and only
// write) while the key's scope is the routed one. Older hosts without
// `activeConnectionId` skip the gate.

function routedScope(): null | string {
  const read = host.activeConnectionId
  return typeof read === 'function' ? read() ?? LOCAL_SCOPE : null
}

/** REST read bound to the scope baked into its query key. `enabled` does not
 *  gate an explicit `refetch()`, so the check lives in the fetch itself: a
 *  request for an outgoing scope never reaches the incoming gateway. */
function scopedGet<T>(scope: string, path: string): Promise<T> {
  const routed = routedScope()
  if (routed !== null && routed !== scope) return Promise.reject(new Error('stale connection scope'))
  return api!<T>(path)
}

/** Every graph query key is `['kanban-graph', version, scope, ...]`. */
const routedToScope = (query: { queryKey: readonly unknown[] }): boolean => keyInRoutedScope(query.queryKey, routedScope())

function assertRoutedScope(scope: string): void {
  const routed = routedScope()
  if (routed !== null && routed !== scope) throw new Error(translate?.('toast.staleConnection') || 'The connection changed.')
}

// ── dispatcher nudge ─────────────────────────────────────────────────────────

const pendingNudges = new Map<string, number>()

/**
 * Core Kanban nudges the dispatcher after every board write so a card moved to
 * Ready starts without waiting out the dispatcher tick. Same here after a status
 * change: debounced per board, fire-and-forget, never blocking the edit.
 */
function nudgeDispatcher(board: string, scope: string): void {
  const key = `${scope}\u0000${board}`
  window.clearTimeout(pendingNudges.get(key))
  pendingNudges.set(key, window.setTimeout(() => {
    pendingNudges.delete(key)
    const routed = routedScope()
    if (!api || (routed !== null && routed !== scope)) return
    void api(`/dispatch?board=${encodeURIComponent(board)}`, { method: 'POST', body: {} }).catch(() => undefined)
  }, DISPATCH_DEBOUNCE_MS))
}

function cancelNudges(): void {
  for (const timer of pendingNudges.values()) window.clearTimeout(timer)
  pendingNudges.clear()
}

// ── persisted view state ─────────────────────────────────────────────────────

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

const loadPositionStore = (): PositionStore => parsePositionStore(pluginStorage?.get<unknown>('node-positions', {}))

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

/**
 * Whether core Kanban's `/kanban` route exists. It ships off by default; when
 * it is off, `/kanban` is not a route and the router reads it as a session id.
 * Read-only: `host.pluginDecisions` on current hosts, its localStorage mirror
 * on older ones.
 */
function isCoreKanbanEnabled(): boolean {
  const decisions = host.pluginDecisions
  if (decisions && typeof decisions.get === 'function') return kanbanEnabledIn(decisions.get())
  try {
    return coreKanbanEnabled(window.localStorage.getItem(PLUGIN_DECISIONS_KEY))
  } catch {
    return false
  }
}

function routeFromHash(hash = window.location.hash): string {
  const index = hash.indexOf('#')
  const target = index === -1 ? hash : hash.slice(index + 1)
  const path = target.split(/[?#]/, 1)[0]
  return path?.startsWith('/') ? path : '/'
}

/** Full route (path + query) of a hash URL, for returning to exactly that page. */
function fullRouteFromUrl(url: string): string {
  const index = url.indexOf('#')
  const target = index === -1 ? '' : url.slice(index + 1)
  return target.startsWith('/') ? target : '/'
}

/**
 * sidebar.nav contributions are route-only in the current Desktop SDK: they
 * expose no click callback or toggle flag. Keep the workaround scoped to this
 * exact contribution and remove it on plugin disposal. Clicking the active row
 * returns to the page the graph was opened from.
 *
 * The sidebar navigates with react-router's `pushState`, which fires no
 * `hashchange`, so the origin is recorded when our row is clicked (capture
 * phase, before the router moves). `hashchange` (`host.navigate`, palette)
 * carries the origin in `oldURL`.
 */
function installSidebarToggle(navLabel: () => string) {
  let returnPath = pluginStorage?.get<string>('sidebar-return-route', '/') ?? '/'

  const remember = (route: string) => {
    if (routeFromHash(route) === GRAPH_ROUTE) return
    returnPath = route
    pluginStorage?.set('sidebar-return-route', route)
  }
  const onHashChange = (event: HashChangeEvent) => {
    if (routeFromHash() === GRAPH_ROUTE && event.oldURL) remember(fullRouteFromUrl(event.oldURL))
  }
  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('button[data-sidebar="menu-button"]')
    if (!button || button.textContent?.trim() !== navLabel()) return
    if (routeFromHash() !== GRAPH_ROUTE) {
      remember(fullRouteFromUrl(window.location.href))
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    host.navigate(returnPath && routeFromHash(returnPath) !== GRAPH_ROUTE ? returnPath : '/')
  }

  window.addEventListener('hashchange', onHashChange)
  document.addEventListener('click', onClick, true)
  return () => {
    window.removeEventListener('hashchange', onHashChange)
    document.removeEventListener('click', onClick, true)
  }
}

/** Escape that belongs to a field, menu or popover: let that thing handle it. */
function escapeIsForInnerControl(event: KeyboardEvent): boolean {
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="menu"], [role="listbox"], .hkg-title-editor, .hkg-complete-form, .hkg-body-editor-wrap')) {
    return true
  }
  if (document.querySelector('[role="menu"], [role="listbox"]')) return true
  // Any open popover except a hover tooltip.
  return [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].some(wrapper => !wrapper.querySelector('[role="tooltip"]'))
}

/** Board switcher placement: the workspace page header on hosts that have it. */
// The page header is only painted while the host treats the workspace as a
// page. A disk plugin's route registers after the first route resolution, so
// after a reload on /kanban-graph the header can still show session tabs and
// the projected switcher is never mounted. Then render it inline instead.
function PageHeaderControl({ children }: { children: ReactNode }) {
  const HeaderControl = sdk.WorkspacePageHeaderControl
  const [inline, setInline] = useState(false)
  useEffect(() => {
    if (!HeaderControl || inline) return
    const check = () => {
      if (!document.querySelector('[data-hkg-board-switcher]')) setInline(true)
    }
    const timer = window.setTimeout(check, 600)
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-hkg-board-switcher]')) {
        window.clearTimeout(timer)
        window.setTimeout(check, 200)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [HeaderControl, inline])
  const marked = <span className="hkg-board-switcher-host" data-hkg-board-switcher="">{children}</span>
  if (inline) return marked
  return HeaderControl
    ? <HeaderControl id="kanban-graph:board-switcher">{marked}</HeaderControl>
    : <Contribute area={TITLEBAR_AREAS.center} id="kanban-graph:board-switcher">{marked}</Contribute>
}

// ── live events ──────────────────────────────────────────────────────────────
//
// One `/events?board=` socket per (connection scope, board) while the graph is
// mounted; our backend hands it to core Kanban's event stream. Frames trigger a
// coalesced refetch of the graph (and of the open task when an event touched
// it). Polling stays as the fallback: 10 s until a socket frame arrives, 60 s
// after. The host socket hides close events, so a dropped socket keeps the 60 s
// poll until it reconnects (it resends the hello) or the board/scope changes.

const eventCursors = new EventCursors()
const liveSockets = new Set<() => void>()
// Asks the mounted socket for (scope, board) to reopen, e.g. after a rewind.
const socketReopen = new EventTarget()
// Bumped on plugin dispose: frames from a socket opened before it are dropped.
let liveGeneration = 0

function closeLiveSockets(): void {
  liveGeneration += 1
  for (const close of [...liveSockets]) close()
  liveSockets.clear()
  eventCursors.clear()
}

/** Opens the board's event socket once the board's database exists and
 *  returns whether a frame (the hello or an event) arrived on it. */
function useLiveEvents(scope: string, board: string, enabled: boolean, onFrame: (effect: FrameEffect) => void): boolean {
  const key = enabled && board ? `${scope}\u0000${board}` : ''
  const [liveKey, setLiveKey] = useState('')
  const [reopen, setReopen] = useState(0)
  const onFrameRef = useRef(onFrame)
  useEffect(() => {
    if (!key) return
    const onReopen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) setReopen(n => n + 1)
    }
    socketReopen.addEventListener('reopen', onReopen)
    return () => socketReopen.removeEventListener('reopen', onReopen)
  }, [key])
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])
  useEffect(() => {
    const dial = openSocket
    if (!key || !dial) return
    // The host dials whatever connection is routed now: never bind a socket to
    // an outgoing scope's key (the effect reruns once the scope publishes).
    const routed = routedScope()
    if (routed !== null && routed !== scope) return
    const generation = liveGeneration
    let current = true
    let lease: number | undefined
    const close = dial(eventsPath(board, eventCursors.get(scope, board)), data => {
      const routedNow = routedScope()
      if (!current || generation !== liveGeneration || (routedNow !== null && routedNow !== scope)) return
      const effect = frameEffect(data, eventCursors.processed(scope, board))
      if (!effect.live) return
      eventCursors.note(scope, board, effect.cursor)
      eventCursors.markProcessed(scope, board, effect.maxEventId)
      // Live is a lease: a silently dropped socket stops renewing it and the
      // graph returns to fast polling.
      setLiveKey(key)
      window.clearTimeout(lease)
      lease = window.setTimeout(() => setLiveKey(previous => (previous === key ? '' : previous)), LIVE_LEASE_MS)
      if (effect.refreshGraph || effect.untargeted || effect.taskIds.length) onFrameRef.current(effect)
    })
    liveSockets.add(close)
    return () => {
      current = false
      window.clearTimeout(lease)
      if (liveSockets.delete(close)) close()
      // A reopened socket for the same board must earn "live" again.
      setLiveKey(previous => (previous === key ? '' : previous))
    }
  }, [board, key, scope, reopen])
  return Boolean(key) && liveKey === key
}

function TaskInspectorController({
  board,
  children,
  manual,
  onClose,
  onOpenKanban,
  onRefresh,
  onSelect,
  openKanbanLabel,
  parents,
  refetchRef,
  scope,
  task
}: {
  board: string
  children: GraphTask[]
  manual: ManualMoves
  onClose: () => void
  onOpenKanban: () => void
  onRefresh: () => Promise<unknown>
  onSelect: (task: GraphTask) => void
  openKanbanLabel: string
  parents: GraphTask[]
  /** Lets the toolbar's refresh button refetch this open detail too. */
  refetchRef: { current: null | (() => Promise<unknown>) }
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
    queryFn: () => scopedGet<TaskDetail>(scope, taskPath),
    enabled: routedToScope,
    refetchInterval: DETAIL_POLL_MS
  })
  const refetchDetail = detailQuery.refetch
  useEffect(() => {
    refetchRef.current = refetchDetail
    return () => {
      if (refetchRef.current === refetchDetail) refetchRef.current = null
    }
  }, [refetchDetail, refetchRef])

  const refresh = async () => {
    await Promise.all([detailQuery.refetch(), onRefresh()])
  }
  const saveContent = async (patch: { title?: string; body?: string }) => {
    setSavingContent(true)
    try {
      assertRoutedScope(scope)
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
      assertRoutedScope(scope)
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
      assertRoutedScope(scope)
      await api!(taskPath, { method: 'PATCH', body: summary ? { status, summary } : { status } })
      nudgeDispatcher(board, scope)
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

  // Detail rows lack the graph-only fields (hidden/truncated link counts); keep them.
  const currentTask: GraphTask = detailQuery.data?.task
    ? {
        ...task,
        ...detailQuery.data.task,
        hidden_parent_count: task.hidden_parent_count,
        hidden_child_count: task.hidden_child_count,
        truncated_parent_count: task.truncated_parent_count,
        truncated_child_count: task.truncated_child_count
      }
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
      openKanbanLabel={openKanbanLabel}
      onRetry={() => void detailQuery.refetch()}
      onSaveContent={saveContent}
      onSelect={onSelect}
      parents={parents}
      savingComment={savingComment}
      savingContent={savingContent}
      savingStatus={pendingStatus !== null}
      statusTargets={statusTargets(currentTask.status, manual)}
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
  const [positionStore, setPositionStore] = useState<PositionStore>(loadPositionStore)
  const [liveNodes, setLiveNodes] = useState<LiveNodes>({ context: '', signature: '', nodes: [] })
  const [dragging, setDragging] = useState(false)
  const flowRef = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const positionStoreRef = useRef(positionStore)
  const fitContextRef = useRef<string | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const restoreNodeIdRef = useRef<string | null>(null)
  const detailRefetchRef = useRef<null | (() => Promise<unknown>)>(null)
  const graphRefetchRef = useRef<null | (() => Promise<unknown>)>(null)
  const selectedIdRef = useRef<string | null>(null)
  const refetchedForSlugRef = useRef('')
  // Search runs on every card; let typing stay responsive on large boards.
  const deferredQuery = useDeferredValue(filters.query)

  // A different gateway has different boards: reload that connection's choice
  // and drop the open card (it belongs to the other gateway).
  useEffect(() => {
    setSelection(loadBoardSelection(scope))
    setSelectedId(null)
  }, [scope])

  const boardsQuery = useQuery<BoardsResponse>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'boards'],
    queryFn: () => scopedGet<BoardsResponse>(scope, '/boards'),
    enabled: routedToScope,
    staleTime: 15_000,
    refetchInterval: 30_000
  })
  const workflowQuery = useQuery<WorkflowResponse>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'workflow'],
    queryFn: () => scopedGet<WorkflowResponse>(scope, '/workflow'),
    enabled: routedToScope,
    staleTime: 5 * 60_000
  })
  const manual: ManualMoves = workflowQuery.data?.manual ?? DEFAULT_MANUAL_MOVES
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
  const [liveBoard, setLiveBoard] = useState({ key: '', initialized: false })
  const liveFrames = useMemo(() => {
    const graph = coalesce(() => void graphRefetchRef.current?.(), LIVE_COALESCE_MS)
    const detail = coalesce(() => void detailRefetchRef.current?.(), LIVE_COALESCE_MS)
    return {
      cancel: () => { graph.cancel(); detail.cancel() },
      onFrame: (effect: FrameEffect) => {
        if (effect.refreshGraph) graph.schedule()
        if (touchesTask(effect, selectedIdRef.current)) detail.schedule()
      }
    }
  }, [])
  useEffect(() => liveFrames.cancel, [liveFrames])
  const live = useLiveEvents(scope, boardValue, liveBoard.key === `${scope}\u0000${boardValue}` && liveBoard.initialized, liveFrames.onFrame)
  const graphQuery = useQuery<GraphPayload>({
    queryKey: ['kanban-graph', CACHE_SCHEMA_VERSION, scope, 'graph', boardValue, includeArchived],
    queryFn: () => scopedGet<GraphPayload>(scope, `/graph?board=${encodeURIComponent(boardValue)}&include_archived=${includeArchived}`).then(graph => {
      // The snapshot's event tail (before `select` strips it): a socket opened
      // later resumes from here instead of the server's tail.
      if (graph.board.initialized) {
        const tail = graph.board.latest_event_id
        if (typeof tail === 'number' && eventCursors.rewindIfBehind(scope, graph.board.slug, tail)) {
          socketReopen.dispatchEvent(new CustomEvent('reopen', { detail: `${scope}\u0000${graph.board.slug}` }))
        }
        eventCursors.note(scope, graph.board.slug, tail)
      }
      return graph
    }),
    enabled: query => Boolean(boardValue) && routedToScope(query),
    // Same board, other archive filter: keep the canvas (and its zoom) while loading.
    // Only for the same connection: two gateways can both have a `default` board.
    placeholderData: (previous, previousQuery) =>
      previous && previousQuery?.queryKey[2] === scope && previous.board.slug === boardValue ? previous : undefined,
    // The event cursor moves on every worker heartbeat; without it an unchanged
    // board keeps its identity and nothing downstream recomputes.
    select: stripEventCursor,
    refetchInterval: graphPollMs(live)
  })
  const positionContext = boardValue
    ? (scope === LOCAL_SCOPE ? `${boardValue}:${settings.direction}` : `${scope}:${boardValue}:${settings.direction}`)
    : ''
  const filtersActive = Boolean(filters.query.trim() || filters.status || filters.assignee || filters.tenant || filters.linkedOnly)
  const positionOverrides = positionContext ? positionStore[positionContext]?.positions ?? EMPTY_POSITIONS : EMPTY_POSITIONS

  const payload = boardValue && graphQuery.data?.board.slug === boardValue ? graphQuery.data : undefined
  const refetchGraph = graphQuery.refetch
  useEffect(() => {
    graphRefetchRef.current = refetchGraph
  }, [refetchGraph])
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  // Open the socket only for a board whose database exists (the backend
  // refuses others) and only once its snapshot set the resume cursor.
  const payloadInitialized = Boolean(payload?.board.initialized) && !graphQuery.isPlaceholderData
  useEffect(() => {
    if (!payload || graphQuery.isPlaceholderData) return
    setLiveBoard({ key: `${scope}\u0000${boardValue}`, initialized: payloadInitialized })
  }, [boardValue, graphQuery.isPlaceholderData, payload, payloadInitialized, scope])
  const refreshing = Boolean(payload) && graphQuery.isPlaceholderData
  const searchFilters = useMemo(() => ({ ...filters, query: deferredQuery }), [deferredQuery, filters])
  const selected = useMemo(() => payload?.nodes.find(task => task.id === selectedId) ?? null, [payload, selectedId])
  const filtered = useMemo(() => payload ? filterGraph(payload, searchFilters) : null, [payload, searchFilters])
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
  const plan = useMemo(
    () => decorated ? planLayout(decorated, settings.hideImplied, settings.direction) : null,
    [decorated, settings.direction, settings.hideImplied]
  )
  // Dagre only re-runs when the linked structure changes, not on status,
  // title or summary updates.
  const structureKey = plan?.structureKey ?? ''
  const linkedLayout = useMemo(
    () => plan ? layoutLinked(plan, settings.direction) : null,
    // Keyed on the structure on purpose: `plan` changes identity on every data update.
    [structureKey]
  )
  const autoElements = useMemo(
    () => decorated && plan && linkedLayout
      ? layoutGraph(decorated, settings.direction, settings.edgeStyle, settings.showMotion, { plan, linkedLayout, unlinkedCollapsed })
      : { nodes: [], edges: [], linkedCount: 0, unlinkedCount: 0, impliedCount: 0 },
    [decorated, linkedLayout, plan, settings.direction, settings.edgeStyle, settings.showMotion, unlinkedCollapsed]
  )
  const positionedNodes = useMemo(
    () => applyPositionOverrides(autoElements.nodes, positionOverrides),
    [autoElements, positionOverrides]
  )
  const nodeSignature = useMemo(() => positionedNodes.map(node => node.id).join('\u0000'), [positionedNodes])
  // While a card is being dragged, keep React Flow's live copy no matter what
  // a background refetch brought in; the drop re-syncs.
  const liveCurrent = liveNodes.context === positionContext && (dragging || liveNodes.signature === nodeSignature)
  const displayedNodes = liveCurrent ? liveNodes.nodes : positionedNodes
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

  const writePositionStore = (next: PositionStore) => {
    if (next === positionStoreRef.current) return
    positionStoreRef.current = next
    setPositionStore(next)
    pluginStorage?.set('node-positions', next)
  }
  const patchFilters = (patch: Partial<GraphFilters>) => setFilters(current => ({ ...current, ...patch }))
  const patchSettings = (patch: Partial<ViewSettings>) => setSettings(current => ({ ...current, ...patch }))
  const fitView = () => void flowRef.current?.fitView({ ...FIT_OPTIONS, duration: 220 })
  const onNodesChange = (changes: NodeChange<GraphNode>[]) => {
    // A drag cancelled by React Flow (multi-touch) never fires onNodeDragStop.
    if (dragging && changes.some(change => change.type === 'position' && change.dragging === false)) setDragging(false)
    if (!positionContext) return
    setLiveNodes(current => {
      const reuse = current.context === positionContext && (dragging || current.signature === nodeSignature)
      return {
        context: positionContext,
        signature: reuse ? current.signature : nodeSignature,
        nodes: applyNodeChanges(changes, reuse ? current.nodes : positionedNodes)
      }
    })
  }
  const persistNodePosition = (node: GraphNode) => {
    // A filtered view has its own layout (hidden neighbours change a card's
    // role and place); a drag there is kept on screen but never saved over the
    // full-board position.
    if (filtersActive) return
    if (!positionContext || !isTaskNode(node)) return
    writePositionStore(savePosition(positionStoreRef.current, positionContext, node.id, {
      x: node.position.x,
      y: node.position.y,
      linked: Boolean(node.data._linked)
    }))
  }
  const resetNodePositions = () => {
    if (!positionContext || !(positionContext in positionStoreRef.current)) return
    const next = { ...positionStoreRef.current }
    delete next[positionContext]
    writePositionStore(next)
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
  const refreshAll = () => {
    void graphQuery.refetch()
    void boardsQuery.refetch()
    void detailRefetchRef.current?.()
  }

  // "Open in Kanban": core's page only exists when its plugin is enabled, and it
  // shows its own board selection, which a plugin cannot set.
  const kanbanEnabled = isCoreKanbanEnabled()
  const boardName = (slug: string) => {
    const board = availableBoards.find(item => item.slug === slug)
    return board?.name || board?.slug || slug
  }
  const openKanbanLabel = !kanbanEnabled
    ? t('state.kanbanDisabled')
    : boardValue && followedSlug && boardValue !== followedSlug
      ? t('inspector.openKanbanOther', boardName(followedSlug))
      : t('inspector.openKanban')
  const openKanban = () => {
    if (!isCoreKanbanEnabled()) {
      host.notify({ kind: 'warning', message: t('state.kanbanDisabled') })
      return
    }
    host.navigate('/kanban')
  }

  const hasFilters = Boolean(filters.query || filters.status || filters.assignee || filters.tenant || filters.linkedOnly || includeArchived)
  const inspectorOpen = Boolean(selectedId)
  const loadError = (!boardsQuery.data && boardsQuery.error) || (!payload && graphQuery.error)
  const loading = boardsQuery.isLoading || (Boolean(boardValue) && !payload && !graphQuery.error)
  const archivedHidden = !includeArchived ? payload?.archived_count ?? 0 : 0

  useEffect(() => pluginStorage?.set('view-settings', settings), [settings])
  // Core just created or imported a board we have not listed yet: refetch once.
  useEffect(() => {
    if (!kanbanSlug || !boardsQuery.data || refetchedForSlugRef.current === `${scope}\u0000${kanbanSlug}`) return
    if (availableBoards.some(board => board.slug === kanbanSlug)) return
    refetchedForSlugRef.current = `${scope}\u0000${kanbanSlug}`
    void boardsQuery.refetch()
  }, [availableBoards, boardsQuery, kanbanSlug])
  // Drop saved positions of tasks that are gone. Only a complete payload (no
  // archived tasks held back, nothing truncated) can tell "gone" from "hidden".
  useEffect(() => {
    if (!payload || !positionContext || refreshing || payload.truncated) return
    if (!includeArchived && (payload.archived_count ?? 0) > 0) return
    writePositionStore(prunePositions(positionStoreRef.current, positionContext, new Set(payload.nodes.map(task => task.id))))
  }, [includeArchived, payload, positionContext, refreshing])
  useEffect(() => {
    if (dragging) return
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
  }, [dragging, nodeSignature, positionContext, positionedNodes])
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
    if (!selectedId || !filtered || refreshing) return
    const visible = filtered.nodes.some(task => task.id === selectedId) && displayedNodes.some(node => node.id === selectedId)
    if (!visible) setSelectedId(null)
  }, [displayedNodes, filtered, refreshing, selectedId])
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
    // Capture phase: decide while an open menu is still in the DOM. Escape in a
    // field, menu or popover belongs to it; only a bare Escape closes the drawer.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || escapeIsForInnerControl(event)) return
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [inspectorOpen])

  const openKanbanAction = kanbanEnabled
    ? <Button onClick={openKanban} size="sm" variant="outline">{t('state.openKanban')}</Button>
    : <p className="hkg-drawer-muted hkg-state-note">{t('state.kanbanDisabled')}</p>
  const renderEmpty = () => {
    if (hasFilters) {
      return <div className="hkg-state"><EmptyState description={t('state.noMatchHint')} title={t('state.noMatch')} /><Button onClick={clearFilters} size="sm" variant="outline">{t('state.clearFilters')}</Button></div>
    }
    if (payload?.board.initialized === false) {
      return <div className="hkg-state"><EmptyState description={t('state.notInitializedHint')} title={t('state.notInitialized')} />{openKanbanAction}</div>
    }
    if (archivedHidden > 0) {
      return <div className="hkg-state"><EmptyState description={t('state.allArchivedHint')} title={t('state.allArchived', archivedHidden)} /><Button onClick={() => setIncludeArchived(true)} size="sm" variant="outline">{t('state.showArchived')}</Button></div>
    }
    return <div className="hkg-state"><EmptyState description={t('state.emptyHint')} title={t('state.empty')} />{openKanbanAction}</div>
  }

  return (
    <main className="hkg-root">
      <header className="hkg-toolbar">
        <h1>{t('title')}</h1>
        <PageHeaderControl>
          <BoardSwitcher boards={availableBoards} followedSlug={followedSlug} onChange={chooseBoard} selection={selection} />
        </PageHeaderControl>
        <span className="hkg-count">{filtered?.nodes.length ?? payload?.nodes.length ?? 0}</span>
        <FilterMenu assignees={assignees} filters={filters} includeArchived={includeArchived} onArchived={setIncludeArchived} onChange={patchFilters} tenants={tenants} />
        <SearchField aria-label={t('toolbar.filterTasks')} containerClassName="hkg-search" onChange={(value: string) => patchFilters({ query: value })} placeholder={t('toolbar.filterTasks')} value={filters.query} />
        <StatusChips active={filters.status} counts={chips} onToggle={status => patchFilters({ status: filters.status === status ? '' : status })} />
        <div className="hkg-spacer" />
        {refreshing && <span className="hkg-refreshing" role="status"><Loader size="xs" />{t('state.refreshing')}</span>}
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
        <RefreshButton onRefresh={refreshAll} refreshing={graphQuery.isFetching} />
      </header>
      {payload?.truncated && (
        <div className="hkg-banner"><Codicon name="warning" size="0.75rem" />{t('state.truncated', payload.nodes.length, payload.total_count ?? payload.nodes.length)}</div>
      )}
      <section className={refreshing ? 'hkg-canvas hkg-canvas-refreshing' : 'hkg-canvas'}>
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
            onNodeDragStart={() => setDragging(true)}
            onNodeDragStop={(_event, node) => {
              persistNodePosition(node)
              setDragging(false)
            }}
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
            key={`${scope}:${boardValue}:${selected.id}`}
            board={boardValue}
            children={relationships.children}
            manual={manual}
            onClose={() => setSelectedId(null)}
            onOpenKanban={openKanban}
            onRefresh={() => graphQuery.refetch()}
            onSelect={selectRelationship}
            openKanbanLabel={openKanbanLabel}
            parents={relationships.parents}
            refetchRef={detailRefetchRef}
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
    openSocket = typeof ctx.socket === 'function' ? ctx.socket.bind(ctx) : null
    pluginStorage = ctx.storage
    const disposeI18n = ctx.i18n?.register ? ctx.i18n.register(LOCALES) : () => {}
    translate = ctx.i18n?.t ?? null
    const disposeStyles = installStyles()
    const disposeSidebarToggle = installSidebarToggle(navLabel)
    const disposeApi = () => {
      cancelNudges()
      closeLiveSockets()
      openSocket = null
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
