// Live event push: pure helpers behind the `/events` socket (see plugin.tsx).
//
// The backend hands the socket to core Kanban's `stream_events`, so frames are
// core's `{ events: [...], cursor: n }`, plus one `{ events: [], hello: true }`
// our route sends right after the handshake is accepted. The hello is what
// marks the push as live (core sends nothing on an idle board), so the graph
// can slow its polling only once a socket really opened.

/** Graph poll while no socket frame was seen (fallback, older hosts, OAuth). */
export const FALLBACK_GRAPH_POLL_MS = 10_000
/** Graph poll once the socket is live: a safety net, not the refresh path. */
export const LIVE_GRAPH_POLL_MS = 60_000
/** Several frames in a burst become one refetch. */
export const LIVE_COALESCE_MS = 250

/** Worker liveness pings: they move the event cursor but never change what
 *  the graph or the inspector shows (the detail query skips them too). */
const SILENT_KINDS = new Set(['heartbeat'])

export interface LiveEvent {
  id?: unknown
  kind?: unknown
  task_id?: unknown
}

export interface FrameEffect {
  /** Frame cursor, when it carried a valid one. */
  cursor?: number
  /** The hello frame or any core frame: the socket is open. */
  live: boolean
  /** Graph needs a refetch: some event other than a heartbeat arrived. */
  refreshGraph: boolean
  /** Task ids those events touched. */
  taskIds: string[]
  /** Some event had no task id: refresh any open detail too. */
  untargeted: boolean
}

const NO_EFFECT: FrameEffect = { live: false, refreshGraph: false, taskIds: [], untargeted: false }

export function frameEffect(data: unknown): FrameEffect {
  if (!data || typeof data !== 'object') return NO_EFFECT
  const frame = data as { cursor?: unknown; events?: unknown; hello?: unknown }
  const events = Array.isArray(frame.events) ? frame.events as LiveEvent[] : null
  if (!events) return NO_EFFECT
  const cursor = typeof frame.cursor === 'number' && Number.isSafeInteger(frame.cursor) && frame.cursor >= 0
    ? frame.cursor
    : undefined
  const visible = events.filter(event => !(event && typeof event === 'object' && SILENT_KINDS.has(String(event.kind))))
  const taskIds = new Set<string>()
  let untargeted = false
  for (const event of visible) {
    const id = event && typeof event === 'object' ? event.task_id : undefined
    if (typeof id === 'string' && id) taskIds.add(id)
    else untargeted = true
  }
  return { cursor, live: true, refreshGraph: visible.length > 0, taskIds: [...taskIds], untargeted }
}

/** Whether the open inspector's detail must refetch for this frame. */
export function touchesTask(effect: FrameEffect, taskId: null | string): boolean {
  return Boolean(taskId) && (effect.untargeted || effect.taskIds.includes(taskId!))
}

/** `/events` path relative to the plugin namespace. No `since` means the server
 *  starts at the board's current tail; an explicit one replays what was missed. */
export function eventsPath(board: string, since?: number): string {
  const params = new URLSearchParams({ board })
  if (since !== undefined) params.set('since', String(since))
  return `/events?${params.toString()}`
}

/** Last frame cursor per (connection scope, board), so a reopened socket
 *  resumes where the previous one stopped. Keyed by scope: two gateways can
 *  both have a `default` board with unrelated event ids. Cursors only move
 *  forward. */
export class EventCursors {
  private readonly cursors = new Map<string, number>()

  private static key(scope: string, board: string): string {
    return `${scope}\u0000${board}`
  }

  get(scope: string, board: string): number | undefined {
    return this.cursors.get(EventCursors.key(scope, board))
  }

  note(scope: string, board: string, cursor: number | undefined): void {
    if (cursor === undefined) return
    const key = EventCursors.key(scope, board)
    const seen = this.cursors.get(key)
    if (seen === undefined || cursor > seen) this.cursors.set(key, cursor)
  }

  clear(): void {
    this.cursors.clear()
  }
}

export function graphPollMs(live: boolean): number {
  return live ? LIVE_GRAPH_POLL_MS : FALLBACK_GRAPH_POLL_MS
}

/** Collapses a burst of calls into one trailing call `ms` later. */
export function coalesce(fn: () => void, ms: number, timers: {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
} = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}): { cancel: () => void; schedule: () => void } {
  let pending: unknown = null
  return {
    schedule() {
      if (pending !== null) return
      pending = timers.set(() => {
        pending = null
        fn()
      }, ms)
    },
    cancel() {
      if (pending !== null) timers.clear(pending)
      pending = null
    }
  }
}
