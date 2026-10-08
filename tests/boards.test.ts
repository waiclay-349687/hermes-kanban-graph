import { describe, expect, it } from 'vitest'

import {
  ALL_BOARDS,
  bandId,
  boardSelectionStorageKey,
  FOLLOW_KANBAN,
  isBandId,
  isSectionId,
  isTaskNode,
  layoutBoards,
  NODE_KEY_SEP,
  nodeKey,
  orderBoards,
  parseBoardSelection,
  positionContextFor,
  resolveBoardSelection,
  splitAllBoards,
  stripEventCursor,
  UNLINKED_SECTION_ID,
  type GraphNode,
  type GraphPayload,
  type GraphTask
} from '../src/graph'
import { allSocketsLive, liveSocketBoards, MAX_LIVE_SOCKETS } from '../src/live'

const task = (board: string, id: string, status = 'todo'): GraphTask => ({ id, board, title: `${board} ${id}`, status, priority: 0, assignee: null, tenant: null })
const meta = (slug: string, name: string, total: number) => ({ slug, name, initialized: true, latest_event_id: 9, total, shown: total, archived_count: 0, truncated: false })

// Two boards that reuse the same task ids, plus one with no cards.
const all: GraphPayload = {
  board: { slug: ALL_BOARDS, latest_event_id: 0, initialized: true },
  boards: [meta('work', 'Work', 4), meta('default', 'Default', 3), meta('alpha', 'Alpha', 0), { ...meta('ghost', 'Ghost', 0), initialized: false }],
  nodes: [
    task('default', 't_a', 'done'), task('default', 't_b'), task('default', 't_lone'),
    task('work', 't_a', 'running'), task('work', 't_b'), task('work', 't_c'), task('work', 't_x')
  ],
  edges: [
    { id: 't_a->t_b', source: 't_a', target: 't_b', board: 'default' },
    { id: 't_a->t_b', source: 't_a', target: 't_b', board: 'work' },
    { id: 't_b->t_c', source: 't_b', target: 't_c', board: 'work' }
  ]
}

type Box = { x0: number; y0: number; x1: number; y1: number }
const box = (node: GraphNode): Box => ({ x0: node.position.x, y0: node.position.y, x1: node.position.x + (node.width ?? 0), y1: node.position.y + (node.height ?? 0) })
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const inside = (inner: Box, outer: Box) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1

describe('all-boards slices', () => {
  it('orders the followed board first, then the rest alphabetically by name', () => {
    expect(orderBoards([{ slug: 'b', name: 'Zeta' }, { slug: 'c', name: 'Alpha' }, { slug: 'a', name: 'Mid' }], 'a').map(board => board.slug)).toEqual(['a', 'c', 'b'])
    expect(splitAllBoards(all, 'work').map(slice => slice.board)).toEqual(['work', 'default'])
    expect(splitAllBoards(all, 'nope').map(slice => slice.board)).toEqual(['default', 'work'])
  })

  it('gives each board its own payload and drops boards without cards', () => {
    const slices = splitAllBoards(all, 'default')
    expect(slices.map(slice => [slice.board, slice.label, slice.payload.nodes.length, slice.payload.edges.length])).toEqual([
      ['default', 'Default', 3, 1],
      ['work', 'Work', 4, 2]
    ])
    // The task keeps its real id and board for API calls.
    expect(slices[1]!.payload.nodes[0]).toMatchObject({ id: 't_a', board: 'work' })
  })

  it('strips every per-board event cursor so heartbeats keep the payload stable', () => {
    expect(stripEventCursor(all).boards!.every(board => board.latest_event_id === 0)).toBe(true)
  })
})

describe('layoutBoards', () => {
  for (const direction of ['LR', 'TB'] as const) {
    it(`keeps ids unique, bands apart and edges within a board (${direction})`, () => {
      const slices = splitAllBoards(all, 'default')
      const result = layoutBoards(slices, direction)
      const ids = result.nodes.map(node => node.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toContain(nodeKey('default', 't_a'))
      expect(ids).toContain(nodeKey('work', 't_a'))

      const bands = result.nodes.filter(node => node.type === 'band')
      expect(bands.map(node => node.id)).toEqual([bandId('default'), bandId('work')])
      expect(bands.every(node => isBandId(node.id) && node.draggable === false && node.selectable === false)).toBe(true)
      expect(overlaps(box(bands[0]!), box(bands[1]!))).toBe(false)
      // Stacked along the cross axis.
      if (direction === 'LR') expect(bands[1]!.position.y).toBeGreaterThan(bands[0]!.position.y)
      else expect(bands[1]!.position.x).toBeGreaterThan(bands[0]!.position.x)

      // Every card sits inside its own board's band.
      for (const node of result.nodes.filter(isTaskNode)) {
        const board = String(node.data.board)
        expect(node.id).toBe(nodeKey(board, node.data.id))
        expect(inside(box(node), box(bands.find(band => band.id === bandId(board))!))).toBe(true)
      }

      expect(result.edges).toHaveLength(3)
      for (const edge of result.edges) {
        const [sourceBoard] = edge.source.split(NODE_KEY_SEP)
        const [targetBoard] = edge.target.split(NODE_KEY_SEP)
        expect(sourceBoard).toBe(targetBoard)
        expect(edge.id.startsWith(`${sourceBoard}${NODE_KEY_SEP}`)).toBe(true)
        expect(ids).toContain(edge.source)
        expect(ids).toContain(edge.target)
      }
      expect(new Set(result.edges.map(edge => edge.id)).size).toBe(3)
      expect(result.linkedCount + result.unlinkedCount).toBe(7)
    })
  }

  it('namespaces each band\'s unlinked section and marks the first band primary', () => {
    const result = layoutBoards(splitAllBoards(all, 'work'), 'LR')
    const sections = result.nodes.filter(node => node.type === 'section').map(node => node.id)
    expect(sections).toEqual([nodeKey('work', UNLINKED_SECTION_ID), nodeKey('default', UNLINKED_SECTION_ID)])
    expect(sections.every(isSectionId)).toBe(true)
    expect(isSectionId(UNLINKED_SECTION_ID)).toBe(true)
    expect(isSectionId(nodeKey('work', 't_a'))).toBe(false)
    expect(result.nodes.filter(node => node.type === 'band').map(node => node.data.primary)).toEqual([true, false])
  })

  it('skips boards whose cards are all filtered out', () => {
    const slices = splitAllBoards(all, 'default').map(slice => slice.board === 'work' ? { ...slice, payload: { ...slice.payload, nodes: [], edges: [] } } : slice)
    const result = layoutBoards(slices, 'LR')
    expect(result.nodes.filter(node => node.type === 'band').map(node => node.id)).toEqual([bandId('default')])
  })
})

describe('board selection persistence', () => {
  const boards = [{ slug: 'default' }, { slug: 'work' }, { slug: 'old', archived: true }]

  it('stores the selection per connection, all boards included', () => {
    expect(boardSelectionStorageKey('local')).toBe('board-selection')
    expect(boardSelectionStorageKey('work-mac')).toBe('board-selection.work-mac')
    expect(parseBoardSelection(ALL_BOARDS)).toBe(ALL_BOARDS)
    expect(parseBoardSelection('work')).toBe('work')
    for (const junk of [undefined, null, '', '  ', 7, {}]) expect(parseBoardSelection(junk)).toBe(FOLLOW_KANBAN)
  })

  it('resolves the all-boards selection while any board is open', () => {
    expect(resolveBoardSelection({ boards, kanbanSlug: 'work', selection: ALL_BOARDS, serverCurrent: 'default' })).toBe(ALL_BOARDS)
    expect(resolveBoardSelection({ boards: [{ slug: 'old', archived: true }], kanbanSlug: '', selection: ALL_BOARDS, serverCurrent: '' })).toBe('')
  })

  it('uses a sentinel that can never be a Kanban board slug', () => {
    expect(/^[a-z0-9][a-z0-9\-_]{0,63}$/.test(ALL_BOARDS)).toBe(false)
    expect(ALL_BOARDS).not.toBe(FOLLOW_KANBAN)
  })

  it('keeps all-boards positions in their own context', () => {
    expect(positionContextFor('local', ALL_BOARDS, 'LR')).toBe('*all*:LR')
    expect(positionContextFor('gw', ALL_BOARDS, 'TB')).toBe('gw:*all*:TB')
    expect(positionContextFor('gw', 'work', 'TB')).toBe('gw:work:TB')
    expect(positionContextFor('gw', '', 'TB')).toBe('')
  })
})

describe('all-boards live sockets', () => {
  it('opens one socket per board up to the cap, none above it', () => {
    const boards = Array.from({ length: MAX_LIVE_SOCKETS }, (_, index) => `b${index}`)
    expect(liveSocketBoards(boards)).toEqual(boards)
    expect(liveSocketBoards([...boards, 'extra'])).toEqual([])
    expect(liveSocketBoards(['a', 'a', ''])).toEqual(['a'])
  })

  it('is live only while every opened socket is live', () => {
    expect(allSocketsLive(['a', 'b'], new Set(['a', 'b']))).toBe(true)
    expect(allSocketsLive(['a', 'b'], new Set(['a']))).toBe(false)
    expect(allSocketsLive([], new Set())).toBe(false)
  })
})
