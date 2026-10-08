import { describe, expect, it } from 'vitest'

import {
  coalesce,
  EventCursors,
  eventsPath,
  FALLBACK_GRAPH_POLL_MS,
  frameEffect,
  graphPollMs,
  LIVE_GRAPH_POLL_MS,
  touchesTask
} from '../src/live'

describe('frameEffect', () => {
  it('reads core frames: cursor, touched tasks, graph refresh', () => {
    const effect = frameEffect({
      cursor: 42,
      events: [
        { id: 41, kind: 'status', task_id: 't_a' },
        { id: 42, kind: 'comment', task_id: 't_b' },
        { id: 40, kind: 'status', task_id: 't_a' }
      ]
    })
    expect(effect).toEqual({ cursor: 42, live: true, maxEventId: 42, refreshGraph: true, taskIds: ['t_a', 't_b'], untargeted: false })
  })

  it('treats heartbeat-only frames as live but changes nothing', () => {
    const effect = frameEffect({ cursor: 9, events: [{ id: 9, kind: 'heartbeat', task_id: 't_a' }] })
    expect(effect).toMatchObject({ cursor: 9, live: true, refreshGraph: false, taskIds: [] })
  })

  it('marks the socket live on the hello frame without a cursor', () => {
    expect(frameEffect({ events: [], hello: true })).toEqual({ live: true, refreshGraph: false, taskIds: [], untargeted: false })
  })

  it('flags events without a task id as untargeted', () => {
    expect(frameEffect({ cursor: 3, events: [{ id: 3, kind: 'board_renamed' }] })).toMatchObject({ refreshGraph: true, untargeted: true })
  })

  it('ignores malformed frames and cursors', () => {
    for (const data of [null, 'x', 7, {}, { events: 'nope' }]) {
      expect(frameEffect(data).live).toBe(false)
    }
    for (const cursor of [-1, 1.5, '3', Number.NaN]) {
      expect(frameEffect({ cursor, events: [] }).cursor).toBeUndefined()
    }
  })
})

describe('touchesTask', () => {
  const effect = frameEffect({ cursor: 2, events: [{ id: 2, kind: 'status', task_id: 't_a' }] })

  it('targets only the open task', () => {
    expect(touchesTask(effect, 't_a')).toBe(true)
    expect(touchesTask(effect, 't_b')).toBe(false)
    expect(touchesTask(effect, null)).toBe(false)
  })

  it('refreshes any open task for untargeted events', () => {
    expect(touchesTask(frameEffect({ events: [{ kind: 'x' }] }), 't_b')).toBe(true)
  })
})

describe('eventsPath', () => {
  it('pins the board and only sends an explicit cursor', () => {
    expect(eventsPath('default')).toBe('/events?board=default')
    expect(eventsPath('my board', 0)).toBe('/events?board=my+board&since=0')
    expect(eventsPath('b', 17)).toBe('/events?board=b&since=17')
  })
})

describe('EventCursors', () => {
  it('keeps one forward-only cursor per scope and board', () => {
    const cursors = new EventCursors()
    cursors.note('local', 'default', 5)
    cursors.note('local', 'default', 3)
    cursors.note('local', 'default', undefined)
    cursors.note('remote-1', 'default', 2)
    cursors.note('local', 'other', 9)
    expect(cursors.get('local', 'default')).toBe(5)
    expect(cursors.get('remote-1', 'default')).toBe(2)
    expect(cursors.get('local', 'other')).toBe(9)
    expect(cursors.get('remote-2', 'default')).toBeUndefined()
    cursors.clear()
    expect(cursors.get('local', 'default')).toBeUndefined()
  })
})

describe('graphPollMs', () => {
  it('polls slowly only while the push is live', () => {
    expect(graphPollMs(true)).toBe(LIVE_GRAPH_POLL_MS)
    expect(graphPollMs(false)).toBe(FALLBACK_GRAPH_POLL_MS)
    expect(LIVE_GRAPH_POLL_MS).toBe(60_000)
    expect(FALLBACK_GRAPH_POLL_MS).toBe(10_000)
  })
})

describe('coalesce', () => {
  function fakeTimers() {
    const pending = new Map<number, () => void>()
    let next = 0
    return {
      pending,
      timers: {
        set: (fn: () => void) => { pending.set(++next, fn); return next },
        clear: (handle: unknown) => { pending.delete(handle as number) }
      },
      flush: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn() } }
    }
  }

  it('runs a burst once', () => {
    const clock = fakeTimers()
    let calls = 0
    const job = coalesce(() => { calls += 1 }, 250, clock.timers)
    job.schedule()
    job.schedule()
    job.schedule()
    expect(clock.pending.size).toBe(1)
    clock.flush()
    expect(calls).toBe(1)
    job.schedule()
    clock.flush()
    expect(calls).toBe(2)
  })

  it('cancel drops the pending call', () => {
    const clock = fakeTimers()
    let calls = 0
    const job = coalesce(() => { calls += 1 }, 250, clock.timers)
    job.schedule()
    job.cancel()
    clock.flush()
    expect(calls).toBe(0)
  })
})

describe('replay, rewind and lease', () => {
  it('skips events a reconnect replays and reports the newest new id', () => {
    const frame = { cursor: 12, events: [{ id: 10, task_id: 't_a', kind: 'status' }, { id: 12, task_id: 't_b', kind: 'comment' }] }
    const first = frameEffect(frame, -1)
    expect(first.refreshGraph).toBe(true)
    expect(first.maxEventId).toBe(12)
    const replay = frameEffect(frame, 12)
    expect(replay.live).toBe(true)
    expect(replay.refreshGraph).toBe(false)
    expect(replay.taskIds).toEqual([])
    expect(frameEffect(frame, 10).taskIds).toEqual(['t_b'])
  })

  it('keeps the processed watermark apart from the snapshot cursor', () => {
    const cursors = new EventCursors()
    cursors.note('local', 'default', 50)
    expect(cursors.processed('local', 'default')).toBe(-1)
    cursors.markProcessed('local', 'default', 51)
    cursors.markProcessed('local', 'default', 49)
    expect(cursors.processed('local', 'default')).toBe(51)
  })

  it('rewinds when a snapshot tail falls behind (replaced database)', () => {
    const cursors = new EventCursors()
    cursors.note('local', 'default', 12)
    cursors.markProcessed('local', 'default', 12)
    expect(cursors.rewindIfBehind('local', 'default', 12)).toBe(false)
    expect(cursors.rewindIfBehind('local', 'default', 1)).toBe(true)
    expect(cursors.get('local', 'default')).toBe(1)
    expect(cursors.processed('local', 'default')).toBe(-1)
    expect(cursors.rewindIfBehind('remote', 'default', 0)).toBe(false)
  })

  it('treats keepalive hellos as live frames without refresh work', () => {
    const hello = frameEffect({ events: [], hello: true, cursor: 7 })
    expect(hello).toMatchObject({ live: true, refreshGraph: false, cursor: 7, taskIds: [], untargeted: false })
  })
})
