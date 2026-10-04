import { describe, expect, it } from 'vitest'

import {
  applyPositionOverrides,
  connectionActivity,
  filterGraph,
  layoutGraph,
  statusTargets,
  summarizeGraph,
  updatePositionOverrides,
  type GraphPayload
} from '../src/graph'

describe('statusTargets', () => {
  it('offers operator-controlled states and keeps the current system state visible', () => {
    expect(statusTargets('todo')).toEqual(['triage', 'todo', 'ready', 'blocked', 'done', 'archived'])
    expect(statusTargets('running')).toEqual(['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'])
    expect(statusTargets('review')).toContain('review')
    expect(statusTargets('scheduled')).toContain('scheduled')
  })
})

describe('connectionActivity', () => {
  it('prioritizes blocked and running work over quieter path states', () => {
    expect(connectionActivity('running', 'todo')).toBe('running')
    expect(connectionActivity('done', 'blocked')).toBe('blocked')
    expect(connectionActivity('blocked', 'running')).toBe('blocked')
  })

  it('recognizes opened, completed, review, and archived paths', () => {
    expect(connectionActivity('done', 'ready')).toBe('ready')
    expect(connectionActivity('done', 'done')).toBe('done')
    expect(connectionActivity('done', 'review')).toBe('review')
    expect(connectionActivity('archived', 'archived')).toBe('archived')
    expect(connectionActivity('todo', 'todo')).toBe('waiting')
  })
})

const payload: GraphPayload = {
  board: { slug: 'default', latest_event_id: 12 },
  nodes: [
    { id: 'root', title: 'Root', status: 'ready', priority: 0, assignee: null, tenant: null },
    { id: 'child-a', title: 'Child A', status: 'todo', priority: 1, assignee: null, tenant: null },
    { id: 'child-b', title: 'Child B', status: 'done', priority: 2, assignee: 'default', tenant: 'ops' },
    { id: 'isolated', title: 'Isolated', status: 'blocked', priority: 3, assignee: null, tenant: null }
  ],
  edges: [
    { id: 'root->child-a', source: 'root', target: 'child-a' },
    { id: 'root->child-b', source: 'root', target: 'child-b' }
  ]
}

describe('layoutGraph', () => {
  it('places prerequisites before dependents and preserves isolated tasks', () => {
    const result = layoutGraph(payload, 'LR')
    const byId = new Map(result.nodes.map(node => [node.id, node]))

    expect(byId.size).toBe(4)
    expect(byId.get('root')!.position.x).toBeLessThan(byId.get('child-a')!.position.x)
    expect(byId.get('root')!.position.x).toBeLessThan(byId.get('child-b')!.position.x)
    expect(byId.has('isolated')).toBe(true)
    expect(result.edges).toHaveLength(2)
  })

  it('supports top-to-bottom layout', () => {
    const result = layoutGraph(payload, 'TB')
    const byId = new Map(result.nodes.map(node => [node.id, node]))

    expect(byId.get('root')!.position.y).toBeLessThan(byId.get('child-a')!.position.y)
  })

  it('publishes the Dagre node dimensions to React Flow consumers', () => {
    const result = layoutGraph(payload, 'LR')

    expect(result.nodes.map(node => [node.width, node.height])).toEqual([
      [272, 104],
      [272, 104],
      [272, 104],
      [272, 104]
    ])
  })

  it.each(['straight', 'elbow', 'curve'] as const)('passes %s geometry to the custom status edge', style => {
    const result = layoutGraph(payload, 'LR', style)

    expect(result.edges.every(edge => edge.type === 'status' && edge.data?.edgeStyle === style)).toBe(true)
    expect(result.edges.find(edge => edge.id === 'root->child-a')?.data?.activity).toBe('waiting')
    expect(result.edges.find(edge => edge.id === 'root->child-b')?.data?.activity).toBe('done')
  })

  it('keeps status gradients while allowing connection motion to be disabled', () => {
    const result = layoutGraph(payload, 'LR', 'elbow', false)

    expect(result.edges.every(edge => edge.type === 'status' && edge.data?.motion === false)).toBe(true)
    expect(result.edges[0]?.data?.sourceStatus).toBe('ready')
    expect(result.edges[0]?.data?.targetStatus).toBe('todo')
  })
})

describe('manual node positions', () => {
  it('overrides only nodes the user moved', () => {
    const nodes = layoutGraph(payload, 'LR').nodes
    const childPosition = nodes.find(node => node.id === 'child-a')!.position

    const moved = applyPositionOverrides(nodes, { root: { x: 42, y: 99 } })

    expect(moved.find(node => node.id === 'root')!.position).toEqual({ x: 42, y: 99 })
    expect(moved.find(node => node.id === 'child-a')!.position).toEqual(childPosition)
  })

  it('records React Flow position changes and ignores selection changes', () => {
    const current = { root: { x: 1, y: 2 } }

    const selected = updatePositionOverrides(current, [{ id: 'root', type: 'select', selected: true }])
    const moved = updatePositionOverrides(current, [{ id: 'root', type: 'position', position: { x: 8, y: 13 }, dragging: true }])

    expect(selected).toBe(current)
    expect(moved).toEqual({ root: { x: 8, y: 13 } })
  })
})

describe('summarizeGraph', () => {
  it('reports linked, isolated, and blocked task counts', () => {
    expect(summarizeGraph(payload)).toEqual({ total: 4, linked: 3, isolated: 1, blocked: 1, done: 1 })
  })
})

describe('filterGraph', () => {
  it('filters nodes and removes dangling edges', () => {
    const filtered = filterGraph(payload, { query: 'child a', status: '', assignee: '', tenant: '' })
    expect(filtered.nodes.map(node => node.id)).toEqual(['child-a'])
    expect(filtered.edges).toEqual([])
  })

  it('combines status, assignee, and tenant filters', () => {
    const filtered = filterGraph(payload, { query: '', status: 'done', assignee: 'default', tenant: 'ops' })
    expect(filtered.nodes.map(node => node.id)).toEqual(['child-b'])
  })

  it('can hide isolated tasks while preserving the linked subgraph', () => {
    const filtered = filterGraph(payload, { query: '', status: '', assignee: '', tenant: '', linkedOnly: true })

    expect(filtered.nodes.map(node => node.id)).toEqual(['root', 'child-a', 'child-b'])
    expect(filtered.edges).toHaveLength(2)
  })
})
