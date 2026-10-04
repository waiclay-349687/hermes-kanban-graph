import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/i18n'

import {
  applyPositionOverrides,
  connectionActivity,
  filterGraph,
  impliedEdgeIds,
  FOLLOW_KANBAN,
  isAdminSummary,
  isTaskNode,
  kanbanBoardStorageKey,
  layoutGraph,
  parseStoredSlug,
  resolveBoardSelection,
  STATUS_META,
  statusBreakdown,
  UNLINKED_SECTION_ID,
  unmetParentCounts,
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

    expect(byId.size).toBe(5)
    expect(byId.get(UNLINKED_SECTION_ID)?.type).toBe('section')
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

    expect(result.nodes.filter(isTaskNode).map(node => [node.width, node.height])).toEqual([
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


describe('unlinked task region', () => {
  const box = (nodes: ReturnType<typeof layoutGraph>['nodes']) => new Map(nodes.map(node => [node.id, node]))

  it('places unlinked tasks in a grid below the dependency graph, most urgent first', () => {
    const many: GraphPayload = {
      ...payload,
      nodes: [
        ...payload.nodes,
        { id: 'u-done', title: 'Done', status: 'done', priority: 0, assignee: null, tenant: null },
        { id: 'u-ready', title: 'Ready', status: 'ready', priority: 5, assignee: null, tenant: null },
        { id: 'u-todo', title: 'Todo', status: 'todo', priority: 0, assignee: null, tenant: null }
      ]
    }
    const result = layoutGraph(many, 'LR')
    const byId = box(result.nodes)
    const linkedBottom = Math.max(...['root', 'child-a', 'child-b'].map(id => byId.get(id)!.position.y + 104))
    const header = byId.get(UNLINKED_SECTION_ID)!

    expect(result.linkedCount).toBe(3)
    expect(result.unlinkedCount).toBe(4)
    expect(header.position.y).toBeGreaterThan(linkedBottom)
    for (const id of ['isolated', 'u-done', 'u-ready', 'u-todo']) {
      expect(byId.get(id)!.position.y).toBeGreaterThan(header.position.y)
      expect(byId.get(id)!.data._linked).toBe(false)
    }
    const order = result.nodes.filter(isTaskNode).filter(node => !node.data._linked).map(node => node.id)
    expect(order).toEqual(['isolated', 'u-ready', 'u-todo', 'u-done'])
    // Grid, not one Dagre rank: at least two unlinked tasks share a row.
    const rows = new Set(order.map(id => byId.get(id)!.position.y))
    expect(rows.size).toBeLessThan(order.length)
  })

  it('collapses unlinked tasks behind the section header', () => {
    const result = layoutGraph(payload, 'LR', 'elbow', true, { unlinkedCollapsed: true })
    const ids = result.nodes.map(node => node.id)

    expect(ids).toContain(UNLINKED_SECTION_ID)
    expect(ids).not.toContain('isolated')
    expect(result.nodes.find(node => node.id === UNLINKED_SECTION_ID)!.data).toMatchObject({ collapsed: true, count: 1 })
  })

  it('shows a plain grid without a collapsible header when nothing is linked', () => {
    const flat: GraphPayload = { ...payload, edges: [] }
    const result = layoutGraph(flat, 'LR', 'elbow', true, { unlinkedCollapsed: true })

    expect(result.nodes.map(node => node.id).sort()).toEqual(['child-a', 'child-b', 'isolated', 'root'])
    expect(new Set(result.nodes.map(node => node.position.y)).size).toBeLessThan(4)
  })

  it('never applies manual positions to the section header', () => {
    const nodes = layoutGraph(payload, 'LR').nodes
    const moved = applyPositionOverrides(nodes, { [UNLINKED_SECTION_ID]: { x: 1, y: 1 } })
    expect(moved.find(node => node.id === UNLINKED_SECTION_ID)!.position).not.toEqual({ x: 1, y: 1 })
  })
})

describe('board selection', () => {
  const boards = [{ slug: 'default' }, { slug: 'life' }, { slug: 'company' }, { slug: 'old', archived: true }]

  it('follows the Kanban page board by default and falls back to the server current board', () => {
    expect(resolveBoardSelection({ boards, kanbanSlug: 'life', selection: FOLLOW_KANBAN, serverCurrent: 'default' })).toBe('life')
    expect(resolveBoardSelection({ boards, kanbanSlug: '', selection: FOLLOW_KANBAN, serverCurrent: 'company' })).toBe('company')
    expect(resolveBoardSelection({ boards, kanbanSlug: 'gone', selection: FOLLOW_KANBAN, serverCurrent: 'default' })).toBe('default')
  })

  it('honours an explicit pin and ignores archived or vanished boards', () => {
    expect(resolveBoardSelection({ boards, kanbanSlug: 'life', selection: 'company', serverCurrent: 'default' })).toBe('company')
    expect(resolveBoardSelection({ boards, kanbanSlug: 'life', selection: 'old', serverCurrent: 'default' })).toBe('life')
    expect(resolveBoardSelection({ boards: [], kanbanSlug: 'life', selection: 'company', serverCurrent: 'default' })).toBe('')
  })

  it('reads the Kanban plugin storage format per connection', () => {
    expect(kanbanBoardStorageKey('local')).toBe('hermes.plugin.kanban.boardSlug')
    expect(kanbanBoardStorageKey('work-mac')).toBe('hermes.plugin.kanban.boardSlug.work-mac')
    expect(parseStoredSlug('"life"')).toBe('life')
    expect(parseStoredSlug('""')).toBe('')
    expect(parseStoredSlug(null)).toBe('')
    expect(parseStoredSlug('{broken')).toBe('')
    expect(parseStoredSlug('42')).toBe('')
  })
})

describe('search', () => {
  const cjk: GraphPayload = {
    board: { slug: 'life', latest_event_id: 1 },
    nodes: [
      { id: 't_1', title: '购物全网候选筛选：价格与配送比较', status: 'blocked', priority: 0, assignee: 'shopper', tenant: null },
      { id: 't_2', title: 'ＡＢＣ Full-width report', status: 'ready', priority: 0, assignee: null, tenant: 'ops' }
    ],
    edges: []
  }

  it('matches Chinese substrings, full-width text, assignee and tenant', () => {
    expect(filterGraph(cjk, { ...EMPTY_SEARCH, query: '配送' }).nodes.map(node => node.id)).toEqual(['t_1'])
    expect(filterGraph(cjk, { ...EMPTY_SEARCH, query: 'abc full' }).nodes.map(node => node.id)).toEqual(['t_2'])
    expect(filterGraph(cjk, { ...EMPTY_SEARCH, query: '  SHOPPER ' }).nodes.map(node => node.id)).toEqual(['t_1'])
    expect(filterGraph(cjk, { ...EMPTY_SEARCH, query: 'ops' }).nodes.map(node => node.id)).toEqual(['t_2'])
    expect(filterGraph(cjk, { ...EMPTY_SEARCH, query: '购物 report' }).nodes).toEqual([])
  })
})

const EMPTY_SEARCH = { query: '', status: '', assignee: '', tenant: '' }

describe('graph facts', () => {
  it('counts statuses in Kanban lane order', () => {
    expect(statusBreakdown(payload.nodes)).toEqual([
      { status: 'todo', count: 1 },
      { status: 'ready', count: 1 },
      { status: 'blocked', count: 1 },
      { status: 'done', count: 1 }
    ])
  })

  it('counts unmet prerequisites using the Kanban done/archived gate', () => {
    const counts = unmetParentCounts({
      ...payload,
      nodes: [...payload.nodes, { id: 'gone', title: 'Gone', status: 'archived', priority: 0, assignee: null, tenant: null }],
      edges: [...payload.edges, { id: 'gone->child-a', source: 'gone', target: 'child-a' }, { id: 'child-b->isolated', source: 'child-b', target: 'isolated' }]
    })
    expect(counts.get('child-a')).toBe(1)
    expect(counts.get('isolated')).toBeUndefined()
  })

  it('recognizes reclaim notes that are not real summaries', () => {
    expect(isAdminSummary('status changed to todo (dashboard/direct)')).toBe(true)
    expect(isAdminSummary('Shipped the parser')).toBe(false)
  })
})

describe('consistency with the bundled Kanban board', () => {
  const coreTypes = join(homedir(), '.hermes/hermes-agent/apps/desktop/src/plugins/kanban/types.ts')

  it.skipIf(!existsSync(coreTypes))('uses the same status tones and icons as COLUMN_META', () => {
    const source = readFileSync(coreTypes, 'utf8')
    for (const [status, meta] of Object.entries(STATUS_META)) {
      expect(source).toContain(`${status}: { codicon: '${meta.icon}', tone: '${meta.tone}' }`)
    }
  })

  it('ships a Chinese bundle with the same keys as English', () => {
    const keys = (tree: Record<string, unknown>, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) =>
      value && typeof value === 'object' ? keys(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`])
    expect(keys(LOCALES.zh as Record<string, unknown>).sort()).toEqual(keys(LOCALES.en as Record<string, unknown>).sort())
  })
})

describe('implied links', () => {
  const chain: GraphPayload = {
    board: { slug: 'b', latest_event_id: 0 },
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, title: id, status: 'todo', priority: 0, assignee: null, tenant: null })),
    edges: [
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'b->c', source: 'b', target: 'c' },
      { id: 'a->c', source: 'a', target: 'c' },
      { id: 'c->d', source: 'c', target: 'd' },
      { id: 'a->d', source: 'a', target: 'd' }
    ]
  }

  it('finds links implied by a longer path', () => {
    expect([...impliedEdgeIds(chain.edges)].sort()).toEqual(['a->c', 'a->d'])
  })

  it('terminates on cycles', () => {
    const cyclic = [
      { id: 'x->y', source: 'x', target: 'y' },
      { id: 'y->x', source: 'y', target: 'x' },
      { id: 'y->z', source: 'y', target: 'z' },
      { id: 'x->z', source: 'x', target: 'z' }
    ]
    expect([...impliedEdgeIds(cyclic)].sort()).toEqual(['x->z', 'y->z'])
  })

  it('marks implied links quiet by default and can hide them', () => {
    const shown = layoutGraph(chain, 'LR')
    expect(shown.edges.find(edge => edge.id === 'a->c')?.data).toMatchObject({ implied: true, motion: false })
    expect(shown.impliedCount).toBe(2)

    const hidden = layoutGraph(chain, 'LR', 'elbow', true, { hideImplied: true })
    expect(hidden.edges.map(edge => edge.id).sort()).toEqual(['a->b', 'b->c', 'c->d'])
    expect(hidden.nodes.filter(isTaskNode)).toHaveLength(4)
  })
})
