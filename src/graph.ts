import dagre from '@dagrejs/dagre'
import { Position, type Edge, type Node, type NodeChange, type XYPosition } from '@xyflow/react'

export type LayoutDirection = 'LR' | 'TB'
export type EdgeStyle = 'curve' | 'elbow' | 'straight'
export type ConnectionActivity = 'archived' | 'blocked' | 'done' | 'ready' | 'review' | 'running' | 'waiting'

export interface StatusEdgeData extends Record<string, unknown> {
  activity: ConnectionActivity
  edgeStyle: EdgeStyle
  /** Also reachable through a longer path (transitively implied). */
  implied?: boolean
  motion: boolean
  sourceStatus: string
  targetStatus: string
}

export const TASK_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const
const OPERATOR_STATUSES = ['triage', 'todo', 'ready', 'blocked', 'done', 'archived'] as const

/**
 * Status presentation, byte-for-byte the bundled Kanban board's COLUMN_META
 * (apps/desktop/src/plugins/kanban/types.ts) so a card reads the same colour in
 * both views.
 */
export const STATUS_META: Record<string, { icon: string; tone: string }> = {
  triage: { icon: 'inbox', tone: 'var(--ui-text-tertiary)' },
  todo: { icon: 'circle-outline', tone: 'var(--ui-text-secondary)' },
  scheduled: { icon: 'watch', tone: '#a78bfa' },
  ready: { icon: 'play-circle', tone: '#60a5fa' },
  running: { icon: 'sync', tone: '#34d399' },
  blocked: { icon: 'error', tone: '#f87171' },
  review: { icon: 'eye', tone: '#fbbf24' },
  done: { icon: 'pass', tone: 'var(--ui-text-tertiary)' },
  archived: { icon: 'archive', tone: 'var(--ui-text-quaternary)' }
}

export const statusMeta = (status: string) => STATUS_META[status] ?? { icon: 'circle-outline', tone: 'var(--ui-text-secondary)' }

/** Attention order: what needs a human first. Used for unlinked-task ordering. */
const STATUS_RANK: Record<string, number> = {
  blocked: 0, running: 1, review: 2, ready: 3, scheduled: 4, todo: 5, triage: 6, done: 7, archived: 8
}

export function statusTargets(current: string): string[] {
  const targets: string[] = [...OPERATOR_STATUSES]
  if (!targets.includes(current)) {
    const currentIndex = TASK_STATUSES.indexOf(current as (typeof TASK_STATUSES)[number])
    const insertAt = TASK_STATUSES.slice(0, Math.max(0, currentIndex)).filter(status => targets.includes(status)).length
    targets.splice(insertAt, 0, current)
  }
  return targets
}

export function connectionActivity(sourceStatus: string, targetStatus: string): ConnectionActivity {
  if (sourceStatus === 'blocked' || targetStatus === 'blocked') return 'blocked'
  if (sourceStatus === 'running' || targetStatus === 'running') return 'running'
  if (sourceStatus === 'review' || targetStatus === 'review') return 'review'
  if (targetStatus === 'archived') return 'archived'
  if (targetStatus === 'done') return 'done'
  if (targetStatus === 'ready' && ['done', 'archived'].includes(sourceStatus)) return 'ready'
  return 'waiting'
}

/** Reclaim notes the core writes on a direct status change; not a real summary. */
export const isAdminSummary = (summary: string) => /^status changed to \w+ \((?:dashboard|kanban-graph)\/direct\)$/.test(summary.trim())

export interface GraphTask {
  [key: string]: unknown
  id: string
  title: string
  body?: string | null
  status: string
  priority: number
  assignee: string | null
  tenant: string | null
  created_at?: number | null
  started_at?: number | null
  completed_at?: number | null
  latest_summary?: string | null
  result?: string | null
  created_by?: string | null
  hidden_parent_count?: number
  hidden_child_count?: number
}

export interface TaskComment {
  id: number
  task_id: string
  author: string
  body: string
  created_at: number
}

export interface TaskEvent {
  id: number
  task_id: string
  kind: string
  payload?: unknown
  created_at: number
}

export interface TaskDetail {
  task: GraphTask
  comments: TaskComment[]
  events: TaskEvent[]
  links: { parents: string[]; children: string[] }
}

export interface GraphLink {
  id: string
  source: string
  target: string
}

export interface GraphPayload {
  board: { slug: string; latest_event_id: number; initialized?: boolean }
  nodes: GraphTask[]
  edges: GraphLink[]
  archived_count?: number
  truncated?: boolean
}

export interface SectionData extends Record<string, unknown> {
  collapsed: boolean
  count: number
  width: number
}

export type TaskNode = Node<GraphTask, 'task'>
export type SectionNode = Node<SectionData, 'section'>
export type GraphNode = SectionNode | TaskNode
export type PositionOverrides = Record<string, XYPosition>

export const NODE_WIDTH = 272
export const NODE_HEIGHT = 104
export const UNLINKED_SECTION_ID = 'hkg:unlinked'
const SECTION_HEIGHT = 30
const GRID_GAP_X = 24
const GRID_GAP_Y = 22
const SECTION_GAP = 56
const MARGIN = 48

export const isTaskNode = (node: GraphNode): node is TaskNode => node.type === 'task'

export interface LayoutOptions {
  /** Hide the unlinked-task grid behind its section header. */
  unlinkedCollapsed?: boolean
  /** Drop links already implied by a longer path (transitive reduction). */
  hideImplied?: boolean
}

const IMPLIED_EDGE_LIMIT = 4_000

/**
 * Ids of links a→c that are implied by another path a→…→c. Read-only display
 * aid: Kanban still stores and enforces every link. Tolerates cycles (legacy or
 * manual corruption) via visited sets; skipped on very large graphs.
 */
export function impliedEdgeIds(edges: readonly GraphLink[]): Set<string> {
  const implied = new Set<string>()
  if (edges.length > IMPLIED_EDGE_LIMIT) return implied
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    const list = children.get(edge.source)
    if (list) list.push(edge.target)
    else children.set(edge.source, [edge.target])
  }
  for (const edge of edges) {
    const visited = new Set<string>([edge.source])
    const stack = (children.get(edge.source) ?? []).filter(next => next !== edge.target)
    let found = false
    while (stack.length > 0 && !found) {
      const id = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const next of children.get(id) ?? []) {
        if (next === edge.target) { found = true; break }
        if (!visited.has(next)) stack.push(next)
      }
    }
    if (found) implied.add(edge.id)
  }
  return implied
}

export interface LayoutResult {
  nodes: GraphNode[]
  edges: Edge<StatusEdgeData>[]
  linkedCount: number
  unlinkedCount: number
  impliedCount: number
}

function compareUnlinked(a: GraphTask, b: GraphTask): number {
  return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || (b.priority ?? 0) - (a.priority ?? 0)
    || (a.created_at ?? 0) - (b.created_at ?? 0)
    || a.id.localeCompare(b.id)
}

function taskNode(task: GraphTask, direction: LayoutDirection, position: XYPosition, linked: boolean): TaskNode {
  return {
    id: task.id,
    type: 'task',
    data: { ...task, _layoutDirection: direction, _linked: linked },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    position,
    sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
    targetPosition: direction === 'LR' ? Position.Left : Position.Top
  } as TaskNode
}

/**
 * Dagre lays out only tasks that take part in a dependency. Unlinked tasks are
 * not dropped: they go into a separate, collapsible grid under the DAG so a
 * board made mostly of independent cards stays readable instead of becoming
 * one very tall Dagre rank.
 */
export function layoutGraph(
  payload: GraphPayload,
  direction: LayoutDirection,
  edgeStyle: EdgeStyle = 'elbow',
  motion = true,
  options: LayoutOptions = {}
): LayoutResult {
  const implied = impliedEdgeIds(payload.edges)
  const shownEdges = options.hideImplied ? payload.edges.filter(edge => !implied.has(edge.id)) : payload.edges
  const linkedIds = new Set<string>()
  for (const edge of shownEdges) {
    linkedIds.add(edge.source)
    linkedIds.add(edge.target)
  }
  const linked = payload.nodes.filter(task => linkedIds.has(task.id))
  const unlinked = payload.nodes.filter(task => !linkedIds.has(task.id)).sort(compareUnlinked)
  const nodes: GraphNode[] = []

  let minX = MARGIN
  let maxX = MARGIN
  let maxY = MARGIN - SECTION_GAP
  if (linked.length > 0) {
    const graph = new dagre.graphlib.Graph()
    graph.setDefaultEdgeLabel(() => ({}))
    graph.setGraph({ rankdir: direction, ranksep: 88, nodesep: 34, edgesep: 20, marginx: MARGIN, marginy: MARGIN })
    for (const task of linked) graph.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    // Implied links barely constrain rank order; keep them out of Dagre so the
    // backbone path drives the layout and fewer edges cross.
    for (const edge of shownEdges) if (!implied.has(edge.id)) graph.setEdge(edge.source, edge.target)
    dagre.layout(graph)
    minX = Number.POSITIVE_INFINITY
    maxX = Number.NEGATIVE_INFINITY
    maxY = Number.NEGATIVE_INFINITY
    for (const task of linked) {
      const point = graph.node(task.id) as { x: number; y: number }
      const position = { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }
      minX = Math.min(minX, position.x)
      maxX = Math.max(maxX, position.x + NODE_WIDTH)
      maxY = Math.max(maxY, position.y + NODE_HEIGHT)
      nodes.push(taskNode(task, direction, position, true))
    }
  }

  if (unlinked.length > 0) {
    const cell = NODE_WIDTH + GRID_GAP_X
    const columns = linked.length > 0
      ? Math.max(1, Math.min(unlinked.length, Math.max(3, Math.min(6, Math.floor((maxX - minX + GRID_GAP_X) / cell)))))
      : Math.max(1, Math.min(unlinked.length, 6, Math.ceil(Math.sqrt(unlinked.length * 1.6))))
    const width = columns * NODE_WIDTH + (columns - 1) * GRID_GAP_X
    const showSection = linked.length > 0
    const collapsed = showSection && Boolean(options.unlinkedCollapsed)
    let top = maxY + SECTION_GAP
    if (showSection) {
      nodes.push({
        id: UNLINKED_SECTION_ID,
        type: 'section',
        data: { collapsed, count: unlinked.length, width },
        position: { x: minX, y: top },
        width,
        height: SECTION_HEIGHT,
        draggable: false,
        selectable: false,
        connectable: false
      } as SectionNode)
      top += SECTION_HEIGHT + 14
    }
    if (!collapsed) {
      unlinked.forEach((task, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        nodes.push(taskNode(task, direction, { x: minX + column * cell, y: top + row * (NODE_HEIGHT + GRID_GAP_Y) }, false))
      })
    }
  }

  const tasks = new Map(payload.nodes.map(task => [task.id, task]))
  const edges: Edge<StatusEdgeData>[] = shownEdges.map(edge => {
    const sourceStatus = tasks.get(edge.source)?.status ?? 'todo'
    const targetStatus = tasks.get(edge.target)?.status ?? 'todo'
    return {
      ...edge,
      type: 'status',
      data: {
        activity: connectionActivity(sourceStatus, targetStatus),
        edgeStyle,
        implied: implied.has(edge.id),
        motion: motion && !implied.has(edge.id),
        sourceStatus,
        targetStatus
      }
    }
  })

  return { nodes, edges, linkedCount: linked.length, unlinkedCount: unlinked.length, impliedCount: implied.size }
}

function validPosition(position: XYPosition | undefined): position is XYPosition {
  return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y))
}

export function applyPositionOverrides<T extends GraphNode>(nodes: T[], overrides: PositionOverrides): T[] {
  return nodes.map(node => {
    if (node.type !== 'task') return node
    const position = overrides[node.id]
    return validPosition(position) ? { ...node, position } : node
  })
}

export function updatePositionOverrides(
  current: PositionOverrides,
  changes: readonly NodeChange<GraphNode>[]
): PositionOverrides {
  let next = current
  for (const change of changes) {
    if (change.type !== 'position' || !validPosition(change.position) || change.id === UNLINKED_SECTION_ID) continue
    if (next === current) next = { ...current }
    next[change.id] = change.position
  }
  return next
}

export interface GraphFilters {
  query: string
  status: string
  assignee: string
  tenant: string
  linkedOnly?: boolean
}

export const EMPTY_FILTERS: GraphFilters = { query: '', status: '', assignee: '', tenant: '', linkedOnly: false }

/** Width/case-insensitive match that also works for CJK and full-width text. */
export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export function filterGraph(payload: GraphPayload, filters: GraphFilters): GraphPayload {
  const query = normalizeSearch(filters.query)
  const linkedIds = filters.linkedOnly ? new Set(payload.edges.flatMap(edge => [edge.source, edge.target])) : null
  const nodes = payload.nodes.filter(node => {
    if (linkedIds && !linkedIds.has(node.id)) return false
    if (filters.status && node.status !== filters.status) return false
    if (filters.assignee && node.assignee !== filters.assignee) return false
    if (filters.tenant && node.tenant !== filters.tenant) return false
    if (!query) return true
    return [node.id, node.title, node.body, node.latest_summary, node.assignee, node.tenant]
      .some(field => typeof field === 'string' && normalizeSearch(field).includes(query))
  })
  const visible = new Set(nodes.map(node => node.id))
  return {
    ...payload,
    nodes,
    edges: payload.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target))
  }
}

export function summarizeGraph(payload: GraphPayload) {
  const linkedIds = new Set(payload.edges.flatMap(edge => [edge.source, edge.target]))
  return {
    total: payload.nodes.length,
    linked: linkedIds.size,
    isolated: payload.nodes.length - linkedIds.size,
    blocked: payload.nodes.filter(node => node.status === 'blocked').length,
    done: payload.nodes.filter(node => node.status === 'done').length
  }
}

/** Per-status counts in board order (only statuses that occur). */
export function statusBreakdown(nodes: readonly GraphTask[]): { status: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
  const ordered: string[] = [...TASK_STATUSES, ...[...counts.keys()].filter(status => !(TASK_STATUSES as readonly string[]).includes(status)).sort()]
  return ordered.filter(status => counts.has(status)).map(status => ({ status, count: counts.get(status)! }))
}

/** Unmet predecessors: visible parents that are not done/archived (the Kanban gate). */
export function unmetParentCounts(payload: GraphPayload): Map<string, number> {
  const status = new Map(payload.nodes.map(task => [task.id, task.status]))
  const counts = new Map<string, number>()
  for (const edge of payload.edges) {
    const parent = status.get(edge.source)
    if (parent && parent !== 'done' && parent !== 'archived') counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
  }
  return counts
}

// ── board selection ──────────────────────────────────────────────────────────

/** Sentinel selection: show whatever board the bundled Kanban page shows. */
export const FOLLOW_KANBAN = '__follow_kanban__'

export interface BoardChoice {
  slug: string
  archived?: boolean
}

export function resolveBoardSelection({ boards, kanbanSlug, selection, serverCurrent }: {
  boards: readonly BoardChoice[]
  kanbanSlug: string
  selection: string
  serverCurrent: string
}): string {
  const available = boards.filter(board => !board.archived).map(board => board.slug)
  if (selection && selection !== FOLLOW_KANBAN && available.includes(selection)) return selection
  if (kanbanSlug && available.includes(kanbanSlug)) return kanbanSlug
  if (serverCurrent && available.includes(serverCurrent)) return serverCurrent
  return available[0] ?? ''
}

/** localStorage key the bundled Kanban plugin persists its selected board under. */
export function kanbanBoardStorageKey(scope: string): string {
  return scope === 'local' ? 'hermes.plugin.kanban.boardSlug' : `hermes.plugin.kanban.boardSlug.${scope}`
}

export function parseStoredSlug(raw: null | string): string {
  if (raw === null) return ''
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
  } catch {
    return ''
  }
}
