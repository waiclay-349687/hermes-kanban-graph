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

/** Manual move matrix (`src -> allowed dst`), the `manual` field of core `GET /workflow`. */
export type ManualMoves = Readonly<Record<string, readonly string[]>>

/**
 * Snapshot of core `kanban_workflow.DEFAULT_WORKFLOW.manual`, used only until
 * the backend's `/workflow` answers (or when an older backend lacks it).
 */
export const DEFAULT_MANUAL_MOVES: ManualMoves = {
  triage: ['ready', 'todo'],
  todo: ['ready', 'scheduled', 'triage'],
  scheduled: ['ready', 'todo', 'triage'],
  ready: ['blocked', 'done', 'review', 'scheduled', 'todo', 'triage'],
  running: ['blocked', 'done', 'ready', 'review', 'scheduled', 'todo', 'triage'],
  blocked: ['done', 'ready', 'scheduled', 'todo', 'triage'],
  review: ['done', 'ready', 'todo', 'triage'],
  done: ['ready', 'todo', 'triage'],
  archived: ['ready', 'todo', 'triage']
}

/**
 * Menu entries for a task: the current status plus every operator-controlled
 * status core accepts as a manual move from it. Archiving is always allowed
 * (core never lists it). System-owned targets (scheduled, review) stay out.
 */
export function statusTargets(current: string, manual: ManualMoves = DEFAULT_MANUAL_MOVES): string[] {
  const allowed = new Set(manual[current] ?? [])
  const targets: string[] = OPERATOR_STATUSES.filter(status =>
    status === current || (status === 'archived' ? current !== 'archived' : allowed.has(status)))
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
  /** Links to tasks cut by the server's node cap (not archived). */
  truncated_parent_count?: number
  truncated_child_count?: number
  /** Owning board; set on every task of the all-boards view (`/graph/all`). */
  board?: string
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
  /** Owning board (all-boards view); links never cross boards. */
  board?: string
}

/** One board of the all-boards view (`GET /graph/all`). */
export interface BoardGraphMeta {
  slug: string
  name?: string | null
  icon?: string | null
  is_current?: boolean
  initialized: boolean
  latest_event_id: number
  /** Tasks matched on this board before any cap. */
  total: number
  /** Tasks of this board present in the response. */
  shown: number
  archived_count: number
  truncated: boolean
  /** The board's database could not be read. */
  error?: boolean
}

export interface GraphPayload {
  board: { slug: string; latest_event_id: number; initialized?: boolean }
  nodes: GraphTask[]
  edges: GraphLink[]
  archived_count?: number
  truncated?: boolean
  /** All-boards view: some board could not be read (totals are a lower bound). */
  incomplete?: boolean
  /** Tasks the server matched before applying its node cap. */
  total_count?: number
  /** All-boards view only: every open board, initialized or not. */
  boards?: BoardGraphMeta[]
}

/**
 * `select` for the graph query. `latest_event_id` moves on every worker
 * heartbeat; dropping it lets React Query's structural sharing keep an
 * unchanged board the same object, so nothing downstream re-runs.
 */
export function stripEventCursor(payload: GraphPayload): GraphPayload {
  const stripped = { ...payload, board: { ...payload.board, latest_event_id: 0 } }
  if (payload.boards) stripped.boards = payload.boards.map(board => ({ ...board, latest_event_id: 0 }))
  return stripped
}

export interface SectionData extends Record<string, unknown> {
  collapsed: boolean
  count: number
  width: number
}

export interface BandData extends Record<string, unknown> {
  board: string
  label: string
  /** Cards of this board in the current (filtered) view. */
  count: number
  width: number
  height: number
  /** The followed/current board, drawn first. */
  primary: boolean
}

export type TaskNode = Node<GraphTask, 'task'>
export type SectionNode = Node<SectionData, 'section'>
/** Background label of one board in the all-boards view. */
export type BandNode = Node<BandData, 'band'>
export type GraphNode = BandNode | SectionNode | TaskNode
/** `linked` records which region the card was in when dragged (absent on 0.2 entries). */
export interface SavedPosition extends XYPosition {
  linked?: boolean
}
export type PositionOverrides = Record<string, SavedPosition>

export const NODE_WIDTH = 272
export const NODE_HEIGHT = 104
export const UNLINKED_SECTION_ID = 'hkg:unlinked'
const SECTION_HEIGHT = 30
const GRID_GAP_X = 24
const GRID_GAP_Y = 22
const SECTION_GAP = 56
const MARGIN = 48

export const isTaskNode = (node: GraphNode): node is TaskNode => node.type === 'task'

// ── all boards ───────────────────────────────────────────────────────────────

/** Selection value of the all-boards view. Never a valid slug (`*` is rejected). */
export const ALL_BOARDS = '*all*'
/** Board slugs are `[a-z0-9][a-z0-9_-]*`, so `::` cannot occur inside one. */
export const NODE_KEY_SEP = '::'
const BAND_PREFIX = `hkg:band${NODE_KEY_SEP}`
const BAND_PAD = 28
const BAND_HEADER = 40
const BAND_GAP = 64
const BAND_MIN_WIDTH = NODE_WIDTH + 2 * BAND_PAD

/** React Flow id of a card in the all-boards view: task ids are only unique per board. */
export const nodeKey = (board: string, taskId: string) => `${board}${NODE_KEY_SEP}${taskId}`
export const bandId = (board: string) => `${BAND_PREFIX}${board}`
export const isBandId = (id: string) => id.startsWith(BAND_PREFIX)
/** The unlinked-section header, in a single board or any band. */
export const isSectionId = (id: string) => id === UNLINKED_SECTION_ID || id.endsWith(`${NODE_KEY_SEP}${UNLINKED_SECTION_ID}`)

export interface BoardSlice {
  board: string
  label: string
  payload: GraphPayload
}

/**
 * Band order: the followed/current board first, then the rest alphabetically
 * by display name (slug as tiebreak).
 */
export function orderBoards<T extends { slug: string; name?: string | null }>(boards: readonly T[], first: string): T[] {
  const label = (board: T) => board.name || board.slug
  return [...boards].sort((a, b) =>
    Number(b.slug === first) - Number(a.slug === first)
      || label(a).localeCompare(label(b))
      || a.slug.localeCompare(b.slug))
}

/**
 * Splits an all-boards payload into one ordinary per-board payload each, so
 * filtering, implied-link reduction and Dagre run per board unchanged. Boards
 * without cards (uninitialized, empty) produce no slice.
 */
export function splitAllBoards(payload: GraphPayload, first: string): BoardSlice[] {
  const nodes = new Map<string, GraphTask[]>()
  const edges = new Map<string, GraphLink[]>()
  for (const task of payload.nodes) {
    if (!task.board) continue
    const list = nodes.get(task.board)
    if (list) list.push(task)
    else nodes.set(task.board, [task])
  }
  for (const edge of payload.edges) {
    if (!edge.board) continue
    const list = edges.get(edge.board)
    if (list) list.push(edge)
    else edges.set(edge.board, [edge])
  }
  const meta = new Map((payload.boards ?? []).map(board => [board.slug, board]))
  for (const slug of nodes.keys()) if (!meta.has(slug)) meta.set(slug, { slug, initialized: true, latest_event_id: 0, total: 0, shown: 0, archived_count: 0, truncated: false })
  return orderBoards([...meta.values()], first)
    .filter(board => nodes.has(board.slug))
    .map(board => ({
      board: board.slug,
      label: board.name || board.slug,
      payload: {
        board: { slug: board.slug, latest_event_id: 0, initialized: true },
        nodes: nodes.get(board.slug)!,
        edges: edges.get(board.slug) ?? [],
        archived_count: board.archived_count,
        truncated: board.truncated,
        total_count: board.total
      }
    }))
}

/** Per-card link count and unmet prerequisites (from the unfiltered board). */
export function decorateGraph(filtered: GraphPayload, full: GraphPayload): GraphPayload {
  const counts = new Map<string, number>()
  for (const edge of filtered.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
  }
  const unmet = unmetParentCounts(full)
  return {
    ...filtered,
    nodes: filtered.nodes.map(task => ({ ...task, _linkCount: counts.get(task.id) ?? 0, _unmet: unmet.get(task.id) ?? 0 }))
  }
}

export interface LayoutOptions {
  /** Hide the unlinked-task grid behind its section header. */
  unlinkedCollapsed?: boolean
  /** Drop links already implied by a longer path (transitive reduction). */
  hideImplied?: boolean
}

/**
 * Strongly connected components (iterative Tarjan). Components are numbered in
 * completion order, which is reverse topological: every successor component of
 * `c` has a smaller number than `c`.
 */
function stronglyConnected(children: readonly number[][]): { comp: Int32Array; count: number; size: Int32Array } {
  const n = children.length
  const comp = new Int32Array(n).fill(-1)
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  const sizes: number[] = []
  let counter = 0
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    const work: [number, number][] = [[root, 0]]
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const [v, next] = frame
      if (next < children[v]!.length) {
        frame[1] = next + 1
        const w = children[v]![next]!
        if (index[w] === -1) {
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          work.push([w, 0])
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!)
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1]![0]
        low[parent] = Math.min(low[parent]!, low[v]!)
      }
      if (low[v] === index[v]) {
        const id = sizes.length
        let size = 0
        let w: number
        do {
          w = stack.pop()!
          onStack[w] = 0
          comp[w] = id
          size++
        } while (w !== v)
        sizes.push(size)
      }
    }
  }
  return { comp, count: sizes.length, size: Int32Array.from(sizes) }
}

/** Plain search for one edge, used only around cycles (legacy/manual corruption). */
function impliedBySearch(children: readonly number[][], source: number, target: number): boolean {
  const visited = new Set<number>([source])
  const stack = children[source]!.filter(next => next !== target)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of children[id]!) {
      if (next === target) return true
      if (!visited.has(next)) stack.push(next)
    }
  }
  return false
}

/**
 * Ids of links a→c that are implied by another path a→…→c. Read-only display
 * aid: Kanban still stores and enforces every link.
 *
 * Reachability is computed once over the component DAG with bitsets, so the
 * cost is O((V + E) · V / 32) instead of one graph search per edge, and there
 * is no edge-count cliff. Edges touching a cycle fall back to a per-edge
 * search, which keeps the old cycle semantics without risking non-termination.
 */
export function impliedEdgeIds(edges: readonly GraphLink[]): Set<string> {
  const implied = new Set<string>()
  const indexOf = new Map<string, number>()
  const key = (id: string) => {
    let value = indexOf.get(id)
    if (value === undefined) {
      value = indexOf.size
      indexOf.set(id, value)
    }
    return value
  }
  const links = edges.map(edge => ({ id: edge.id, source: key(edge.source), target: key(edge.target) }))
  const children: number[][] = Array.from({ length: indexOf.size }, () => [])
  for (const link of links) if (link.source !== link.target) children[link.source]!.push(link.target)

  const { comp, count, size } = stronglyConnected(children)
  const words = Math.ceil(count / 32)
  // reach[c] = components strictly reachable from component c (never c itself).
  const reach = new Uint32Array(count * words)
  const members: number[][] = Array.from({ length: count }, () => [])
  for (let v = 0; v < children.length; v++) members[comp[v]!]!.push(v)
  for (let c = 0; c < count; c++) {
    const row = c * words
    for (const v of members[c]!) {
      for (const w of children[v]!) {
        const d = comp[w]!
        if (d === c) continue
        const from = d * words
        for (let i = 0; i < words; i++) reach[row + i] |= reach[from + i]
        reach[row + (d >>> 5)] |= 1 << (d & 31)
      }
    }
  }

  const bySource = new Map<number, typeof links>()
  for (const link of links) {
    if (link.source === link.target) continue
    const list = bySource.get(link.source)
    if (list) list.push(link)
    else bySource.set(link.source, [link])
  }
  const union = new Uint32Array(words)
  for (const [source, outgoing] of bySource) {
    union.fill(0)
    for (const child of children[source]!) {
      const from = comp[child]! * words
      for (let i = 0; i < words; i++) union[i] |= reach[from + i]
    }
    const sourceInCycle = size[comp[source]!]! > 1
    for (const link of outgoing) {
      const target = comp[link.target]!
      const found = sourceInCycle || size[target]! > 1
        ? impliedBySearch(children, source, link.target)
        : (union[target >>> 5]! & (1 << (target & 31))) !== 0
      if (found) implied.add(link.id)
    }
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

/** Which links are drawn, which are implied, and which tasks Dagre must place. */
export interface LayoutPlan {
  implied: Set<string>
  shownEdges: GraphLink[]
  linkedIds: string[]
  /** Identity of the Dagre input: changes only when the linked structure does. */
  structureKey: string
}

export function planLayout(payload: GraphPayload, hideImplied = false, direction: LayoutDirection = 'LR'): LayoutPlan {
  const implied = impliedEdgeIds(payload.edges)
  const shownEdges = hideImplied ? payload.edges.filter(edge => !implied.has(edge.id)) : payload.edges
  const linkedSet = new Set<string>()
  for (const edge of shownEdges) {
    linkedSet.add(edge.source)
    linkedSet.add(edge.target)
  }
  const linkedIds = payload.nodes.filter(task => linkedSet.has(task.id)).map(task => task.id)
  const backbone = shownEdges.filter(edge => !implied.has(edge.id)).map(edge => edge.id)
  return { implied, shownEdges, linkedIds, structureKey: [direction, linkedIds.join('\u0001'), backbone.join('\u0001')].join('\u0002') }
}

/** Dagre output for the linked tasks, reusable while `structureKey` holds. */
export interface LinkedLayout {
  structureKey: string
  positions: Map<string, XYPosition>
  minX: number
  maxX: number
  maxY: number
}

export function layoutLinked(plan: LayoutPlan, direction: LayoutDirection): LinkedLayout {
  const positions = new Map<string, XYPosition>()
  if (plan.linkedIds.length === 0) {
    return { structureKey: plan.structureKey, positions, minX: MARGIN, maxX: MARGIN, maxY: MARGIN - SECTION_GAP }
  }
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, ranksep: 88, nodesep: 34, edgesep: 20, marginx: MARGIN, marginy: MARGIN })
  for (const id of plan.linkedIds) graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  // Implied links barely constrain rank order; keep them out of Dagre so the
  // backbone path drives the layout and fewer edges cross.
  for (const edge of plan.shownEdges) if (!plan.implied.has(edge.id)) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const id of plan.linkedIds) {
    const point = graph.node(id) as { x: number; y: number }
    const position = { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }
    minX = Math.min(minX, position.x)
    maxX = Math.max(maxX, position.x + NODE_WIDTH)
    maxY = Math.max(maxY, position.y + NODE_HEIGHT)
    positions.set(id, position)
  }
  return { structureKey: plan.structureKey, positions, minX, maxX, maxY }
}

/**
 * Dagre lays out only tasks that take part in a dependency. Unlinked tasks are
 * not dropped: they go into a separate, collapsible grid under the DAG so a
 * board made mostly of independent cards stays readable instead of becoming
 * one very tall Dagre rank.
 *
 * Pass a precomputed `plan` / `linkedLayout` to skip the expensive phases when
 * only task data (status, title, summary) changed.
 */
export function layoutGraph(
  payload: GraphPayload,
  direction: LayoutDirection,
  edgeStyle: EdgeStyle = 'elbow',
  motion = true,
  options: LayoutOptions & { plan?: LayoutPlan; linkedLayout?: LinkedLayout } = {}
): LayoutResult {
  const plan = options.plan ?? planLayout(payload, options.hideImplied, direction)
  const { implied, shownEdges } = plan
  const linkedLayout = options.linkedLayout?.structureKey === plan.structureKey ? options.linkedLayout : layoutLinked(plan, direction)
  const linkedIds = new Set(plan.linkedIds)
  const linked = payload.nodes.filter(task => linkedIds.has(task.id))
  const unlinked = payload.nodes.filter(task => !linkedIds.has(task.id)).sort(compareUnlinked)
  const nodes: GraphNode[] = linked.map(task => taskNode(task, direction, linkedLayout.positions.get(task.id)!, true))
  const { minX, maxX, maxY } = linkedLayout

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

export interface BoardLayoutInput extends BoardSlice {
  plan?: LayoutPlan
  linkedLayout?: LinkedLayout
}

/**
 * All-boards layout: every board is laid out on its own with `layoutGraph`
 * (its Dagre block plus its unlinked grid), then the blocks are stacked along
 * the cross axis (downwards for LR, rightwards for TB), each inside a labelled
 * background band. Node and edge ids are namespaced with `nodeKey`, and edges
 * only ever join cards of the same board.
 */
export function layoutBoards(
  slices: readonly BoardLayoutInput[],
  direction: LayoutDirection,
  edgeStyle: EdgeStyle = 'elbow',
  motion = true,
  options: LayoutOptions = {}
): LayoutResult {
  const bands: GraphNode[] = []
  const nodes: GraphNode[] = []
  const edges: Edge<StatusEdgeData>[] = []
  let linkedCount = 0
  let unlinkedCount = 0
  let impliedCount = 0
  let cursorX = MARGIN
  let cursorY = MARGIN
  slices.forEach((slice, index) => {
    if (slice.payload.nodes.length === 0) return
    const result = layoutGraph(slice.payload, direction, edgeStyle, motion, { ...options, plan: slice.plan, linkedLayout: slice.linkedLayout })
    if (result.nodes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const node of result.nodes) {
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
      maxX = Math.max(maxX, node.position.x + (node.width ?? NODE_WIDTH))
      maxY = Math.max(maxY, node.position.y + (node.height ?? NODE_HEIGHT))
    }
    const width = Math.max(BAND_MIN_WIDTH, maxX - minX + 2 * BAND_PAD)
    const height = maxY - minY + BAND_HEADER + 2 * BAND_PAD
    const dx = cursorX + BAND_PAD - minX
    const dy = cursorY + BAND_HEADER + BAND_PAD - minY
    bands.push({
      id: bandId(slice.board),
      type: 'band',
      data: { board: slice.board, label: slice.label, count: slice.payload.nodes.length, width, height, primary: index === 0 },
      position: { x: cursorX, y: cursorY },
      width,
      height,
      zIndex: -1,
      draggable: false,
      selectable: false,
      focusable: false,
      connectable: false
    } as BandNode)
    for (const node of result.nodes) {
      nodes.push({
        ...node,
        id: nodeKey(slice.board, node.id),
        position: { x: node.position.x + dx, y: node.position.y + dy },
        ...(node.type === 'task' ? { data: { ...node.data, board: slice.board } } : {})
      } as GraphNode)
    }
    for (const edge of result.edges) {
      edges.push({ ...edge, id: nodeKey(slice.board, edge.id), source: nodeKey(slice.board, edge.source), target: nodeKey(slice.board, edge.target) })
    }
    linkedCount += result.linkedCount
    unlinkedCount += result.unlinkedCount
    impliedCount += result.impliedCount
    if (direction === 'LR') cursorY += height + BAND_GAP
    else cursorX += width + BAND_GAP
  })
  return { nodes: [...bands, ...nodes], edges, linkedCount, unlinkedCount, impliedCount }
}

function validPosition(position: XYPosition | undefined): position is XYPosition {
  return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y))
}

/**
 * A manual position only applies while the task keeps the linked/unlinked
 * role it had when dragged: a card that joins or leaves the DAG moves to a
 * different region, and its old spot would overlap freshly laid-out cards.
 * Entries without `linked` (saved before 0.3) are treated as linked.
 */
export function applyPositionOverrides<T extends GraphNode>(nodes: T[], overrides: PositionOverrides): T[] {
  // All-boards view: positions are stored relative to the card's band origin,
  // so a band that moves (board order, a board above growing, filters) carries
  // its manually placed cards along instead of dropping them into another band.
  const origins = bandOrigins(nodes)
  const placed = nodes.map(node => {
    if (node.type !== 'task') return node
    const saved = overrides[node.id]
    if (!validPosition(saved) || (saved.linked ?? true) !== Boolean(node.data._linked)) return node
    const origin = taskBandOrigin(node, origins)
    return { ...node, position: { x: saved.x + origin.x, y: saved.y + origin.y } }
  })
  return origins.size ? fitBands(placed) : placed
}

function bandOrigins(nodes: readonly GraphNode[]): Map<string, XYPosition> {
  const origins = new Map<string, XYPosition>()
  for (const node of nodes) if (node.type === 'band') origins.set(String((node.data as { board?: unknown }).board), node.position)
  return origins
}

function taskBandOrigin(node: GraphNode, origins: Map<string, XYPosition>): XYPosition {
  const board = (node.data as { board?: unknown }).board
  return (typeof board === 'string' && origins.get(board)) || { x: 0, y: 0 }
}

/** Position to persist for a dragged card: band-relative in the all-boards view. */
export function storedPosition(node: GraphNode, layoutNodes: readonly GraphNode[]): XYPosition {
  const origin = taskBandOrigin(node, bandOrigins(layoutNodes))
  return { x: node.position.x - origin.x, y: node.position.y - origin.y }
}

/** Grows each band so manually moved cards stay inside it. */
function fitBands<T extends GraphNode>(nodes: T[]): T[] {
  const bounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
  for (const node of nodes) {
    if (node.type !== 'task') continue
    const board = (node.data as { board?: unknown }).board
    if (typeof board !== 'string') continue
    const b = bounds.get(board) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    b.minX = Math.min(b.minX, node.position.x)
    b.minY = Math.min(b.minY, node.position.y)
    b.maxX = Math.max(b.maxX, node.position.x + (node.width ?? NODE_WIDTH))
    b.maxY = Math.max(b.maxY, node.position.y + (node.height ?? NODE_HEIGHT))
    bounds.set(board, b)
  }
  return nodes.map(node => {
    if (node.type !== 'band') return node
    const data = node.data as { board: string; width: number; height: number }
    const b = bounds.get(data.board)
    if (!b) return node
    const x = Math.min(node.position.x, b.minX - BAND_PAD)
    const y = Math.min(node.position.y, b.minY - BAND_HEADER - BAND_PAD)
    const width = Math.max(node.position.x + data.width, b.maxX + BAND_PAD) - x
    const height = Math.max(node.position.y + data.height, b.maxY + BAND_PAD) - y
    if (x === node.position.x && y === node.position.y && width === data.width && height === data.height) return node
    return { ...node, position: { x, y }, width, height, data: { ...data, width, height } }
  })
}

/** Saved positions per layout context (`[scope:]board:direction`), newest use first to survive the cap. */
export interface PositionStore {
  [context: string]: { at: number; positions: PositionOverrides }
}

export const MAX_SAVED_POSITIONS = 3_000

function parsePositions(raw: unknown): PositionOverrides {
  const positions: PositionOverrides = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return positions
  for (const [taskId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { x, y, linked } = value as { x?: unknown; y?: unknown; linked?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    positions[taskId] = typeof linked === 'boolean' ? { x, y, linked } : { x, y }
  }
  return positions
}

/**
 * Reads the current store shape, or migrates the 0.2 shape
 * (`{ context: { taskId: {x, y} } }`) with every context at time 0.
 */
export function parsePositionStore(raw: unknown): PositionStore {
  const store: PositionStore = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store
  for (const [context, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as { at?: unknown; positions?: unknown }
    const current = typeof entry.at === 'number' && entry.positions && typeof entry.positions === 'object'
    const positions = parsePositions(current ? entry.positions : value)
    if (Object.keys(positions).length > 0) store[context] = { at: current ? entry.at as number : 0, positions }
  }
  return store
}

/** Drops whole contexts, least recently used first, until at most `max` positions remain. */
export function capPositionStore(store: PositionStore, max = MAX_SAVED_POSITIONS): PositionStore {
  const contexts = Object.entries(store).sort(([, a], [, b]) => b.at - a.at)
  const next: PositionStore = {}
  let total = 0
  for (const [context, entry] of contexts) {
    const ids = Object.keys(entry.positions)
    if (total >= max) break
    if (total + ids.length <= max) {
      next[context] = entry
      total += ids.length
      continue
    }
    // The newest context alone exceeds the cap: keep its most recently written
    // positions (insertion order) so the cap is hard.
    if (total === 0) {
      const keep = ids.slice(ids.length - max)
      next[context] = { at: entry.at, positions: Object.fromEntries(keep.map(id => [id, entry.positions[id]])) }
      total = max
    }
  }
  return next
}

export function savePosition(store: PositionStore, context: string, id: string, position: SavedPosition, now = Date.now()): PositionStore {
  const positions = { ...(store[context]?.positions ?? {}), [id]: position }
  return capPositionStore({ ...store, [context]: { at: now, positions } })
}

/** Removes positions of tasks no longer on the board; returns `store` itself when nothing changed. */
export function prunePositions(store: PositionStore, context: string, liveIds: ReadonlySet<string>): PositionStore {
  const entry = store[context]
  if (!entry) return store
  const kept = Object.entries(entry.positions).filter(([id]) => liveIds.has(id))
  if (kept.length === Object.keys(entry.positions).length) return store
  const next = { ...store }
  if (kept.length === 0) delete next[context]
  else next[context] = { at: entry.at, positions: Object.fromEntries(kept) }
  return next
}

export function updatePositionOverrides(
  current: PositionOverrides,
  changes: readonly NodeChange<GraphNode>[]
): PositionOverrides {
  let next = current
  for (const change of changes) {
    if (change.type !== 'position' || !validPosition(change.position) || isSectionId(change.id) || isBandId(change.id)) continue
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
  /** All-boards view only: show one board. Applied per slice, not by `filterGraph`. */
  board?: string
}

export const EMPTY_FILTERS: GraphFilters = { query: '', status: '', assignee: '', tenant: '', linkedOnly: false, board: '' }

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

// ── connection scope ─────────────────────────────────────────────────────────

/**
 * Whether a query keyed `['kanban-graph', version, scope, ...]` may fetch now.
 * `routed` is the connection a request issued now would reach (`null` when the
 * host cannot tell, which disables the gate).
 */
export function keyInRoutedScope(queryKey: readonly unknown[], routed: null | string): boolean {
  return routed === null || queryKey[2] === routed
}

// ── board selection ──────────────────────────────────────────────────────────

/** Sentinel selection: show whatever board the bundled Kanban page shows. */
export const FOLLOW_KANBAN = '__follow_kanban__'

export interface BoardChoice {
  slug: string
  archived?: boolean
}

/** Returns a board slug, `ALL_BOARDS`, or '' when there is no open board. */
export function resolveBoardSelection({ boards, kanbanSlug, selection, serverCurrent }: {
  boards: readonly BoardChoice[]
  kanbanSlug: string
  selection: string
  serverCurrent: string
}): string {
  const available = boards.filter(board => !board.archived).map(board => board.slug)
  if (selection === ALL_BOARDS && available.length > 0) return ALL_BOARDS
  if (selection && selection !== FOLLOW_KANBAN && available.includes(selection)) return selection
  if (kanbanSlug && available.includes(kanbanSlug)) return kanbanSlug
  if (serverCurrent && available.includes(serverCurrent)) return serverCurrent
  return available[0] ?? ''
}

/** Plugin-storage key of the graph's own board selection, per connection. */
export function boardSelectionStorageKey(scope: string): string {
  return scope === 'local' ? 'board-selection' : `board-selection.${scope}`
}

/** A stored selection: a slug, `ALL_BOARDS` or `FOLLOW_KANBAN` (the default). */
export function parseBoardSelection(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : FOLLOW_KANBAN
}

/** Saved-position context: `[scope:]board:direction`; `board` may be `ALL_BOARDS`. */
export function positionContextFor(scope: string, board: string, direction: LayoutDirection): string {
  if (!board) return ''
  return scope === 'local' ? `${board}:${direction}` : `${scope}:${board}:${direction}`
}

/** localStorage key the bundled Kanban plugin persists its selected board under. */
export function kanbanBoardStorageKey(scope: string): string {
  return scope === 'local' ? 'hermes.plugin.kanban.boardSlug' : `hermes.plugin.kanban.boardSlug.${scope}`
}

/** localStorage key of the Desktop's explicit plugin enable/disable choices. */
export const PLUGIN_DECISIONS_KEY = 'hermes.desktop.pluginDecisions.v2'

/**
 * Whether core Kanban's page is registered. Core ships `defaultEnabled: false`,
 * so only an explicit `true` choice enables it; without that `/kanban` is not
 * a route and the router would read it as a session id.
 */
export function coreKanbanEnabled(rawDecisions: null | string): boolean {
  if (rawDecisions === null) return false
  try {
    return kanbanEnabledIn(JSON.parse(rawDecisions))
  } catch {
    return false
  }
}

/** Same rule over the decoded decisions (`host.pluginDecisions.get()`). */
export function kanbanEnabledIn(decisions: unknown): boolean {
  return Boolean(decisions && typeof decisions === 'object' && (decisions as Record<string, unknown>).kanban === true)
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
