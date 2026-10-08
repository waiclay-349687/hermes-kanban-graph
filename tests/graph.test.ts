import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/i18n'

import {
  applyPositionOverrides,
  capPositionStore,
  connectionActivity,
  coreKanbanEnabled,
  DEFAULT_MANUAL_MOVES,
  kanbanEnabledIn,
  keyInRoutedScope,
  layoutLinked,
  parsePositionStore,
  planLayout,
  prunePositions,
  savePosition,
  stripEventCursor,
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

const coreWorkflow = join(homedir(), '.hermes/hermes-agent/hermes_cli/kanban_workflow.py')

describe('statusTargets', () => {
  it('offers only moves the core manual matrix accepts, plus archive', () => {
    expect(statusTargets('todo')).toEqual(['triage', 'todo', 'ready', 'archived'])
    expect(statusTargets('triage')).toEqual(['triage', 'todo', 'ready', 'archived'])
    expect(statusTargets('running')).toEqual(['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived'])
    expect(statusTargets('done')).toEqual(['triage', 'todo', 'ready', 'done', 'archived'])
    expect(statusTargets('archived')).toEqual(['triage', 'todo', 'ready', 'archived'])
  })

  it('keeps the current system state visible', () => {
    expect(statusTargets('review')).toEqual(['triage', 'todo', 'ready', 'review', 'done', 'archived'])
    expect(statusTargets('scheduled')).toEqual(['triage', 'todo', 'scheduled', 'ready', 'archived'])
  })

  it('follows the matrix the backend serves', () => {
    expect(statusTargets('todo', { todo: ['done'] })).toEqual(['todo', 'done', 'archived'])
    expect(statusTargets('unknown', {})).toEqual(['unknown', 'archived'])
  })

  it.skipIf(!existsSync(coreWorkflow))('ships a fallback identical to core DEFAULT_WORKFLOW.manual', () => {
    const source = readFileSync(coreWorkflow, 'utf8')
    for (const [src, targets] of Object.entries(DEFAULT_MANUAL_MOVES)) {
      const key = src === 'archived' ? 'ARCHIVED' : `"${src}"`
      const line = source.split('\n').find(row => row.trim().startsWith(`${key}: (`))
      expect(line, src).toBeDefined()
      const listed = [...line!.matchAll(/"([a-z]+)"/g)].map(match => match[1]).filter(name => name !== src)
      expect([...listed].sort(), src).toEqual([...targets].sort())
    }
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

describe('implied links at scale', () => {
  const bruteForce = (edges: { id: string; source: string; target: string }[]) => {
    const children = new Map<string, string[]>()
    for (const edge of edges) children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
    const implied = new Set<string>()
    for (const edge of edges) {
      const seen = new Set<string>([edge.source])
      const stack = (children.get(edge.source) ?? []).filter(next => next !== edge.target)
      let found = false
      while (stack.length > 0 && !found) {
        const id = stack.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        for (const next of children.get(id) ?? []) {
          if (next === edge.target) found = true
          else if (!seen.has(next)) stack.push(next)
        }
      }
      if (found) implied.add(edge.id)
    }
    return implied
  }

  it('matches a per-edge search on random DAGs and cyclic graphs', () => {
    let seed = 7
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    for (let round = 0; round < 40; round++) {
      const size = 3 + Math.floor(random() * 30)
      const edges = new Map<string, { id: string; source: string; target: string }>()
      for (let i = 0; i < size * 2; i++) {
        let a = Math.floor(random() * size)
        let b = Math.floor(random() * size)
        if (a === b) continue
        // Mostly forward edges; a few back edges make cycles in odd rounds.
        if (a > b && (round % 2 === 0 || random() < 0.8)) [a, b] = [b, a]
        const id = `n${a}->n${b}`
        edges.set(id, { id, source: `n${a}`, target: `n${b}` })
      }
      const list = [...edges.values()]
      expect([...impliedEdgeIds(list)].sort(), `round ${round}`).toEqual([...bruteForce(list)].sort())
    }
  })

  it('has no edge-count cliff: a 6,000-edge fan-out is still reduced', () => {
    const edges = []
    for (let i = 0; i < 3_000; i++) {
      edges.push({ id: `root->m${i}`, source: 'root', target: `m${i}` })
      edges.push({ id: `m${i}->leaf`, source: `m${i}`, target: 'leaf' })
    }
    edges.push({ id: 'root->leaf', source: 'root', target: 'leaf' })
    const started = performance.now()
    const implied = impliedEdgeIds(edges)
    expect(implied).toEqual(new Set(['root->leaf']))
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('layout reuse', () => {
  it('drops the moving event cursor so unchanged boards compare equal', () => {
    const a = stripEventCursor({ ...payload, board: { slug: 'default', latest_event_id: 1 } })
    const b = stripEventCursor({ ...payload, board: { slug: 'default', latest_event_id: 99 } })
    expect(a).toEqual(b)
    expect(a.board.latest_event_id).toBe(0)
  })

  it('keeps the structure key when only task data changes', () => {
    const before = planLayout(payload, false, 'LR')
    const changed = { ...payload, nodes: payload.nodes.map(node => ({ ...node, status: 'running', title: `${node.title}!` })) }
    expect(planLayout(changed, false, 'LR').structureKey).toBe(before.structureKey)
    expect(planLayout(payload, false, 'TB').structureKey).not.toBe(before.structureKey)
    const relinked = { ...payload, edges: [...payload.edges, { id: 'child-a->isolated', source: 'child-a', target: 'isolated' }] }
    expect(planLayout(relinked, false, 'LR').structureKey).not.toBe(before.structureKey)
  })

  it('reuses a cached Dagre layout for the same structure', () => {
    const plan = planLayout(payload, false, 'LR')
    const cached = layoutLinked(plan, 'LR')
    cached.positions.set('root', { x: -500, y: -500 })
    const result = layoutGraph(payload, 'LR', 'elbow', true, { plan, linkedLayout: cached })
    expect(result.nodes.find(node => node.id === 'root')!.position).toEqual({ x: -500, y: -500 })
    const stale = { ...cached, structureKey: 'other' }
    expect(layoutGraph(payload, 'LR', 'elbow', true, { plan, linkedLayout: stale }).nodes.find(node => node.id === 'root')!.position)
      .not.toEqual({ x: -500, y: -500 })
  })
})

describe('saved positions', () => {
  it('applies a position only while the task keeps its linked role', () => {
    const nodes = layoutGraph(payload, 'LR').nodes
    const moved = applyPositionOverrides(nodes, {
      root: { x: 1, y: 2, linked: true },
      isolated: { x: 3, y: 4, linked: true },
      'child-a': { x: 5, y: 6 }
    })
    const byId = new Map(moved.map(node => [node.id, node.position]))
    expect(byId.get('root')).toEqual({ x: 1, y: 2 })
    expect(byId.get('isolated')).not.toEqual({ x: 3, y: 4 })
    // 0.2 entries without `linked` count as linked.
    expect(byId.get('child-a')).toEqual({ x: 5, y: 6 })
  })

  it('migrates the 0.2 shape and drops junk', () => {
    const store = parsePositionStore({
      'default:LR': { root: { x: 1, y: 2 }, bad: { x: 'no', y: 1 } },
      'life:TB': { at: 5, positions: { a: { x: 0, y: 0, linked: false } } },
      broken: 3
    })
    expect(store).toEqual({
      'default:LR': { at: 0, positions: { root: { x: 1, y: 2 } } },
      'life:TB': { at: 5, positions: { a: { x: 0, y: 0, linked: false } } }
    })
  })

  it('prunes gone tasks and caps total storage by least recent context', () => {
    let store = savePosition({}, 'old', 'a', { x: 0, y: 0, linked: true }, 1)
    store = savePosition(store, 'old', 'b', { x: 0, y: 0, linked: true }, 2)
    store = savePosition(store, 'new', 'c', { x: 1, y: 1, linked: false }, 3)
    expect(prunePositions(store, 'old', new Set(['a', 'b']))).toBe(store)
    expect(prunePositions(store, 'old', new Set(['a'])).old!.positions).toEqual({ a: { x: 0, y: 0, linked: true } })
    expect(prunePositions(store, 'new', new Set())).not.toHaveProperty('new')
    expect(Object.keys(capPositionStore(store, 2))).toEqual(['new'])
    expect(Object.keys(capPositionStore(store, 3)).sort()).toEqual(['new', 'old'])
  })

  it('caps a single oversized context hard, keeping its newest positions', () => {
    const positions = Object.fromEntries(Array.from({ length: 3001 }, (_, i) => [`t${i}`, { x: i, y: 0, linked: true }]))
    const capped = capPositionStore({ big: { at: 1, positions } }, 3000)
    const ids = Object.keys(capped.big!.positions)
    expect(ids).toHaveLength(3000)
    expect(ids[0]).toBe('t1')
    expect(ids.at(-1)).toBe('t3000')
  })
})

describe('core Kanban availability', () => {
  it('treats only an explicit enable as a registered /kanban route', () => {
    expect(coreKanbanEnabled(null)).toBe(false)
    expect(coreKanbanEnabled('{"kanban":true}')).toBe(true)
    expect(coreKanbanEnabled('{"kanban":false}')).toBe(false)
    expect(coreKanbanEnabled('{}')).toBe(false)
    expect(coreKanbanEnabled('{broken')).toBe(false)
    expect(kanbanEnabledIn({ kanban: true })).toBe(true)
    expect(kanbanEnabledIn(Object.freeze({ other: true }))).toBe(false)
    expect(kanbanEnabledIn(undefined)).toBe(false)
  })
})

describe('connection scope gate', () => {
  const key = ['kanban-graph', 3, 'work-mac', 'graph', 'default', false] as const

  it('fetches only while the key scope is the routed connection', () => {
    expect(keyInRoutedScope(key, 'work-mac')).toBe(true)
    expect(keyInRoutedScope(key, 'local')).toBe(false)
    expect(keyInRoutedScope(['kanban-graph', 3, 'local', 'boards'], 'local')).toBe(true)
  })

  it('stays open on hosts that cannot report the routed connection', () => {
    expect(keyInRoutedScope(key, null)).toBe(true)
  })
})
