import dagre from '@dagrejs/dagre'
import { Position, type Edge, type Node, type NodeChange, type XYPosition } from '@xyflow/react'

export type LayoutDirection = 'LR' | 'TB'
export type EdgeStyle = 'curve' | 'elbow' | 'straight'
export type ConnectionActivity = 'archived' | 'blocked' | 'done' | 'ready' | 'review' | 'running' | 'waiting'

export interface StatusEdgeData extends Record<string, unknown> {
  activity: ConnectionActivity
  edgeStyle: EdgeStyle
  motion: boolean
  sourceStatus: string
  targetStatus: string
}

export const TASK_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const
const OPERATOR_STATUSES = ['triage', 'todo', 'ready', 'blocked', 'done', 'archived'] as const

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
  board: { slug: string; latest_event_id: number }
  nodes: GraphTask[]
  edges: GraphLink[]
}

export type TaskNode = Node<GraphTask, 'task'>
export type PositionOverrides = Record<string, XYPosition>

const NODE_WIDTH = 272
const NODE_HEIGHT = 104

export function layoutGraph(
  payload: GraphPayload,
  direction: LayoutDirection,
  edgeStyle: EdgeStyle = 'elbow',
  motion = true
): { nodes: TaskNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, ranksep: 88, nodesep: 34, edgesep: 20, marginx: 48, marginy: 48 })

  for (const task of payload.nodes) graph.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of payload.edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)

  const nodes: TaskNode[] = payload.nodes.map(task => {
    const point = graph.node(task.id) as { x: number; y: number }
    return {
      id: task.id,
      type: 'task',
      data: { ...task, _layoutDirection: direction },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top
    } as TaskNode
  })

  const tasks = new Map(payload.nodes.map(task => [task.id, task]))
  const edges: Edge<StatusEdgeData>[] = payload.edges.map(edge => {
    const sourceStatus = tasks.get(edge.source)?.status ?? 'todo'
    const targetStatus = tasks.get(edge.target)?.status ?? 'todo'
    return {
      ...edge,
      type: 'status',
      data: {
        activity: connectionActivity(sourceStatus, targetStatus),
        edgeStyle,
        motion,
        sourceStatus,
        targetStatus
      }
    }
  })

  return { nodes, edges }
}

function validPosition(position: XYPosition | undefined): position is XYPosition {
  return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y))
}

export function applyPositionOverrides(nodes: TaskNode[], overrides: PositionOverrides): TaskNode[] {
  return nodes.map(node => {
    const position = overrides[node.id]
    return validPosition(position) ? { ...node, position } : node
  })
}

export function updatePositionOverrides(
  current: PositionOverrides,
  changes: readonly NodeChange<TaskNode>[]
): PositionOverrides {
  let next = current
  for (const change of changes) {
    if (change.type !== 'position' || !validPosition(change.position)) continue
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

export function filterGraph(payload: GraphPayload, filters: GraphFilters): GraphPayload {
  const query = filters.query.trim().toLowerCase()
  const linkedIds = filters.linkedOnly ? new Set(payload.edges.flatMap(edge => [edge.source, edge.target])) : null
  const nodes = payload.nodes.filter(node => {
    if (linkedIds && !linkedIds.has(node.id)) return false
    if (filters.status && node.status !== filters.status) return false
    if (filters.assignee && node.assignee !== filters.assignee) return false
    if (filters.tenant && node.tenant !== filters.tenant) return false
    if (!query) return true
    return `${node.id} ${node.title} ${node.body ?? ''}`.toLowerCase().includes(query)
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
