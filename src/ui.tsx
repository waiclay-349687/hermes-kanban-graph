import {
  Button,
  cn,
  Codicon,
  CopyButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Loader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  profileColor,
  profileColorSoft,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  Tip
} from '@hermes/plugin-sdk'
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type NodeProps
} from '@xyflow/react'
import { memo, useEffect, useState, type ChangeEvent, type CSSProperties } from 'react'

import { statusTargets, TASK_STATUSES, type EdgeStyle, type GraphFilters, type GraphTask, type LayoutDirection, type StatusEdgeData, type TaskComment, type TaskEvent, type TaskNode } from './graph'

export interface BoardMeta {
  slug: string
  name?: string | null
  archived?: boolean
  is_current?: boolean
  total?: number
}

export interface ViewSettings {
  direction: LayoutDirection
  edgeStyle: EdgeStyle
  showGrid: boolean
  showMiniMap: boolean
  showMotion: boolean
}

const STATUS_META: Record<string, { icon: string; tone: string }> = {
  triage: { icon: 'inbox', tone: 'var(--ui-text-tertiary)' },
  todo: { icon: 'circle-outline', tone: 'var(--ui-text-secondary)' },
  scheduled: { icon: 'watch', tone: 'var(--ui-purple)' },
  ready: { icon: 'play-circle', tone: 'var(--ui-blue)' },
  running: { icon: 'sync', tone: 'var(--ui-green)' },
  blocked: { icon: 'error', tone: 'var(--ui-red)' },
  review: { icon: 'eye', tone: 'var(--ui-yellow)' },
  done: { icon: 'pass', tone: 'var(--ui-text-tertiary)' },
  archived: { icon: 'archive', tone: 'var(--ui-text-quaternary)' }
}

export const statusMeta = (status: string) => STATUS_META[status] ?? { icon: 'circle-outline', tone: 'var(--ui-text-secondary)' }
const labelStatus = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)
const shortId = (id: string) => id.replace(/^t_/, '').slice(0, 6)

function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-./]+/).filter(Boolean)
  return `${parts[0]?.[0] ?? '?'}${parts[1]?.[0] ?? ''}`.toUpperCase()
}

function Avatar({ name }: { name: string }) {
  const color = profileColor(name)
  return (
    <span
      className="hkg-avatar"
      style={{ backgroundColor: color ? profileColorSoft(color, 22) : 'var(--ui-bg-quaternary)', color: color ?? 'var(--ui-text-secondary)' }}
      title={name}
    >
      {initials(name)}
    </span>
  )
}

type StatusConnection = Edge<StatusEdgeData, 'status'>

function StatusConnectionEdge({
  data,
  id,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY
}: EdgeProps<StatusConnection>) {
  const edgeData = data ?? {
    activity: 'waiting',
    edgeStyle: 'elbow',
    motion: true,
    sourceStatus: 'todo',
    targetStatus: 'todo'
  }
  const pathArgs = { sourcePosition, sourceX, sourceY, targetPosition, targetX, targetY }
  const [path] = edgeData.edgeStyle === 'straight'
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : edgeData.edgeStyle === 'curve'
      ? getBezierPath(pathArgs)
      : getSmoothStepPath({ ...pathArgs, borderRadius: 8 })
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '-')
  const gradientId = `hkg-gradient-${safeId}`
  const markerId = `hkg-arrow-${safeId}`
  const sourceTone = statusMeta(edgeData.sourceStatus).tone
  const targetTone = statusMeta(edgeData.targetStatus).tone
  const flowStyle = { '--hkg-edge-flow-tone': targetTone } as CSSProperties

  return (
    <>
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={gradientId} x1={sourceX} x2={targetX} y1={sourceY} y2={targetY}>
          <stop offset="0%" stopColor={sourceTone} stopOpacity="0.58" />
          <stop offset="48%" stopColor={sourceTone} stopOpacity="0.78" />
          <stop offset="100%" stopColor={targetTone} stopOpacity="0.9" />
        </linearGradient>
        <marker id={markerId} markerHeight="7" markerUnits="strokeWidth" markerWidth="7" orient="auto" refX="6" refY="3.5" viewBox="0 0 7 7">
          <path d="M 0 0 L 7 3.5 L 0 7 z" fill={targetTone} />
        </marker>
      </defs>
      <BaseEdge
        className={cn('hkg-status-edge-base', `hkg-status-edge-${edgeData.activity}`)}
        id={id}
        markerEnd={`url(#${markerId})`}
        path={path}
        style={{ ...style, stroke: `url(#${gradientId})` }}
      />
      {edgeData.motion && (
        <path
          className={cn('hkg-edge-flow', `hkg-edge-flow-${edgeData.activity}`)}
          d={path}
          fill="none"
          style={flowStyle}
        />
      )}
      {edgeData.motion && edgeData.activity === 'blocked' && (
        <circle className="hkg-edge-blocked-beacon" cx={targetX} cy={targetY} fill={targetTone} r="3.4" />
      )}
    </>
  )
}

function TaskCardView({ data, selected }: NodeProps<TaskNode>) {
  const vertical = data._layoutDirection === 'TB'
  const meta = statusMeta(data.status)
  const summary = data.latest_summary || data.body
  const linkCount = Number(data._linkCount ?? 0)

  return (
    <div
      className={cn('hkg-node', selected && 'hkg-node-selected')}
      data-status={data.status}
      style={{ '--hkg-tone': meta.tone } as CSSProperties}
    >
      <Handle position={vertical ? Position.Top : Position.Left} type="target" />
      <div className="hkg-node-title">{data.title || data.id}</div>
      {summary && <div className="hkg-node-summary">{summary}</div>}
      <div className="hkg-node-footer">
        {data.assignee && <Avatar name={data.assignee} />}
        <div className="hkg-node-meta">
          <span className="hkg-priority"><Codicon name="arrow-up" size="0.65rem" />{data.priority}</span>
          {linkCount > 0 && <span><Codicon name="references" size="0.65rem" />{linkCount}</span>}
          <span className="hkg-short-id">{shortId(data.id)}</span>
        </div>
      </div>
      <Handle position={vertical ? Position.Bottom : Position.Right} type="source" />
    </div>
  )
}

export const NODE_TYPES = { task: memo(TaskCardView) }
export const EDGE_TYPES = { status: memo(StatusConnectionEdge) }

function MenuLabel({ children }: { children: string }) {
  return <div className="hkg-menu-label">{children}</div>
}

function Check({ active }: { active: boolean }) {
  return active ? <Codicon className="hkg-menu-check" name="check" size="0.8rem" /> : null
}

export function FilterMenu({
  assignees,
  filters,
  includeArchived,
  onArchived,
  onChange,
  tenants
}: {
  assignees: string[]
  filters: GraphFilters
  includeArchived: boolean
  onArchived: (value: boolean) => void
  onChange: (patch: Partial<GraphFilters>) => void
  tenants: string[]
}) {
  const active = Boolean(filters.status || filters.assignee || filters.tenant || filters.linkedOnly || includeArchived)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Filter graph" className={cn(active && 'hkg-control-active')} size="icon-xs" variant="ghost">
          <Codicon name="filter" size="0.85rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hkg-filter-menu">
        <MenuLabel>Status</MenuLabel>
        <DropdownMenuItem onSelect={() => onChange({ status: '' })}>All statuses<Check active={!filters.status} /></DropdownMenuItem>
        {TASK_STATUSES.map(status => {
          const meta = statusMeta(status)
          return (
            <DropdownMenuItem key={status} onSelect={() => onChange({ status })}>
              <span className="hkg-status-dot" style={{ backgroundColor: meta.tone }} />
              {labelStatus(status)}
              <Check active={filters.status === status} />
            </DropdownMenuItem>
          )
        })}
        {assignees.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <MenuLabel>Assignee</MenuLabel>
            <DropdownMenuItem onSelect={() => onChange({ assignee: '' })}>All profiles<Check active={!filters.assignee} /></DropdownMenuItem>
            {assignees.map(name => (
              <DropdownMenuItem key={name} onSelect={() => onChange({ assignee: name })}>
                <Avatar name={name} />{name}<Check active={filters.assignee === name} />
              </DropdownMenuItem>
            ))}
          </>
        )}
        {tenants.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <MenuLabel>Tenant</MenuLabel>
            <DropdownMenuItem onSelect={() => onChange({ tenant: '' })}>All tenants<Check active={!filters.tenant} /></DropdownMenuItem>
            {tenants.map(name => <DropdownMenuItem key={name} onSelect={() => onChange({ tenant: name })}>{name}<Check active={filters.tenant === name} /></DropdownMenuItem>)}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange({ linkedOnly: !filters.linkedOnly })}>
          Linked tasks only<Check active={Boolean(filters.linkedOnly)} />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onArchived(!includeArchived)}>
          Show archived<Check active={includeArchived} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const LAYOUT_OPTIONS = [
  { id: 'LR', label: 'Horizontal' },
  { id: 'TB', label: 'Vertical' }
] as const
const EDGE_OPTIONS = [
  { id: 'straight', label: 'Straight' },
  { id: 'elbow', label: 'Elbow' },
  { id: 'curve', label: 'Curve' }
] as const

function ToggleRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="hkg-toggle-row">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} size="xs" />
    </label>
  )
}

export function GraphSettings({ hasManualPositions, onChange, onFit, onResetPositions, settings }: {
  hasManualPositions: boolean
  onChange: (patch: Partial<ViewSettings>) => void
  onFit: () => void
  onResetPositions: () => void
  settings: ViewSettings
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button aria-label="Graph settings" className={cn(open && 'hkg-control-active')} size="icon-xs" variant="ghost">
          <Codicon name="settings-gear" size="0.85rem" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="hkg-settings-popover">
        <div className="hkg-setting-group">
          <div className="hkg-setting-label">Layout</div>
          <SegmentedControl className="hkg-segmented" onChange={direction => onChange({ direction })} options={LAYOUT_OPTIONS} value={settings.direction} />
        </div>
        <div className="hkg-setting-group">
          <div className="hkg-setting-label">Connections</div>
          <SegmentedControl className="hkg-segmented" onChange={edgeStyle => onChange({ edgeStyle })} options={EDGE_OPTIONS} value={settings.edgeStyle} />
        </div>
        <div className="hkg-setting-group hkg-setting-toggles">
          <ToggleRow checked={settings.showMotion} label="Connection motion" onChange={showMotion => onChange({ showMotion })} />
          <ToggleRow checked={settings.showMiniMap} label="MiniMap" onChange={showMiniMap => onChange({ showMiniMap })} />
          <ToggleRow checked={settings.showGrid} label="Dot grid" onChange={showGrid => onChange({ showGrid })} />
        </div>
        <div className="hkg-settings-actions">
          <Button className="hkg-fit-button" onClick={() => { onFit(); setOpen(false) }} size="xs" variant="outline">
            <Codicon name="screen-full" size="0.75rem" />Fit graph to view
          </Button>
          <Button disabled={!hasManualPositions} onClick={() => { onResetPositions(); setOpen(false) }} size="xs" variant="ghost">
            <Codicon name="discard" size="0.75rem" />Reset positions
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function BoardSwitcher({ boards, onChange, value }: { boards: BoardMeta[]; onChange: (slug: string) => void; value: string }) {
  if (boards.length === 0 || !value) return null
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label="Kanban board" className="hkg-board-switcher" size="xs">
        <Codicon name="project" size="0.75rem" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {boards.map(board => <SelectItem key={board.slug} value={board.slug}>{board.name || board.slug}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function MetaRow({ children, label }: { children: React.ReactNode; label: string }) {
  return <><dt>{label}</dt><dd>{children}</dd></>
}

function DependencySide({ label, onSelect, tasks }: { label: string; onSelect: (task: GraphTask) => void; tasks: GraphTask[] }) {
  if (tasks.length === 0) return null
  return (
    <div className="hkg-dependency-side">
      <div className="hkg-dependency-side-label">{label}</div>
      <div className="hkg-dependency-list">
        {tasks.map(task => (
          <button key={task.id} onClick={() => onSelect(task)} type="button">
            <span className="hkg-status-dot" style={{ backgroundColor: statusMeta(task.status).tone }} />
            <span>{task.title || task.id}</span>
            <code>{shortId(task.id)}</code>
          </button>
        ))}
      </div>
    </div>
  )
}

function StatusMenu({ disabled, onChange, status }: { disabled: boolean; onChange: (status: string) => void; status: string }) {
  const meta = statusMeta(status)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Change task status. Current status: ${labelStatus(status)}`}
          className="hkg-status-menu-trigger"
          disabled={disabled}
          style={{ backgroundColor: `color-mix(in srgb, ${meta.tone} 15%, transparent)`, color: meta.tone }}
          type="button"
        >
          <span className="hkg-status-dot" style={{ backgroundColor: meta.tone }} />
          {labelStatus(status)}
          {disabled ? <Loader size="xs" /> : <Codicon name="chevron-down" size="0.7rem" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {statusTargets(status).map(target => {
          const targetMeta = statusMeta(target)
          return (
            <DropdownMenuItem key={target} onSelect={() => target !== status && onChange(target)}>
              <span className="hkg-status-dot" style={{ backgroundColor: targetMeta.tone }} />
              {labelStatus(target)}
              {target === status && <Codicon className="hkg-menu-check" name="check" size="0.8rem" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Inspector({
  children,
  comments,
  detailError,
  detailLoading,
  detailReady,
  events,
  onAddComment,
  onChangeStatus,
  onClose,
  onOpenKanban,
  onRetry,
  onSaveContent,
  onSelect,
  parents,
  savingComment,
  savingContent,
  savingStatus,
  task
}: {
  children: GraphTask[]
  comments: TaskComment[]
  detailError: string
  detailLoading: boolean
  detailReady: boolean
  events: TaskEvent[]
  onAddComment: (body: string) => Promise<boolean>
  onChangeStatus: (status: string) => Promise<boolean>
  onClose: () => void
  onOpenKanban: () => void
  onRetry: () => void
  onSaveContent: (patch: { title?: string; body?: string }) => Promise<boolean>
  onSelect: (task: GraphTask) => void
  parents: GraphTask[]
  savingComment: boolean
  savingContent: boolean
  savingStatus: boolean
  task: GraphTask
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)
  const [draftBody, setDraftBody] = useState(task.body || '')
  const [comment, setComment] = useState('')

  useEffect(() => {
    if (editingTitle) return
    setDraftTitle(task.title)
  }, [editingTitle, task.id, task.title])

  useEffect(() => {
    if (editingBody) return
    setDraftBody(task.body || '')
  }, [editingBody, task.body, task.id])

  const saveTitle = async () => {
    const title = draftTitle.trim()
    if (!title) return
    if (await onSaveContent({ title })) setEditingTitle(false)
  }
  const saveBody = async () => {
    if (await onSaveContent({ body: draftBody })) setEditingBody(false)
  }
  const addComment = async () => {
    const body = comment.trim()
    if (!body) return
    if (await onAddComment(body)) setComment('')
  }

  return (
    <aside className="hkg-inspector" aria-label="Task details">
      <header className="hkg-inspector-head">
        <div className="hkg-inspector-topline">
          <div className="hkg-inspector-status-row">
            {detailReady && <StatusMenu disabled={savingStatus} onChange={status => void onChangeStatus(status)} status={task.status} />}
            <span className="hkg-task-id">{shortId(task.id)}</span>
          </div>
          <div className="hkg-inspector-head-actions">
            <CopyButton appearance="icon" buttonSize="icon-xs" text={task.id} />
            <Tip label="Open full Kanban"><Button aria-label="Open full Kanban" onClick={onOpenKanban} size="icon-xs" variant="ghost"><Codicon name="project" /></Button></Tip>
            <Button aria-label="Close details" onClick={onClose} size="icon-xs" variant="ghost"><Codicon name="close" /></Button>
          </div>
        </div>
        {detailReady && (editingTitle ? (
          <div className="hkg-title-editor">
            <Input autoFocus onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftTitle(event.target.value)} value={draftTitle} />
            <div className="hkg-inline-editor-actions">
              <Button disabled={savingContent} onClick={() => { setDraftTitle(task.title); setEditingTitle(false) }} size="xs" variant="ghost">Cancel</Button>
              <Button disabled={savingContent || !draftTitle.trim()} onClick={() => void saveTitle()} size="xs" variant="primary">{savingContent ? <Loader size="xs" /> : 'Save'}</Button>
            </div>
          </div>
        ) : (
          <div className="hkg-title-row"><h2>{task.title || task.id}</h2><Button aria-label="Edit title" onClick={() => setEditingTitle(true)} size="icon-xs" variant="ghost"><Codicon name="edit" /></Button></div>
        ))}
      </header>
      <div className="hkg-inspector-scroll">
        {detailError ? (
          <div className="hkg-detail-state hkg-detail-error"><Codicon name="warning" /><span>{detailError}</span><Button onClick={onRetry} size="xs" variant="outline">Retry</Button></div>
        ) : detailLoading || !detailReady ? (
          <div className="hkg-detail-state hkg-detail-loading"><Loader size="sm" /><span>Loading full task…</span></div>
        ) : <>
        <dl className="hkg-inspector-grid">
          <MetaRow label="Assignee">{task.assignee ? <span className="hkg-inline-meta"><Avatar name={task.assignee} />{task.assignee}</span> : <span className="hkg-drawer-muted">Unassigned</span>}</MetaRow>
          <MetaRow label="Priority">P{task.priority}</MetaRow>
          <MetaRow label="Tenant">{task.tenant || <span className="hkg-drawer-muted">None</span>}</MetaRow>
          {task.created_by && <MetaRow label="Created by">{task.created_by}</MetaRow>}
          {task.created_at && <MetaRow label="Created"><time>{new Date(task.created_at * 1000).toLocaleString()}</time></MetaRow>}
        </dl>
        <section className="hkg-drawer-section hkg-description-section">
          <div className="hkg-section-label">Description<Button aria-label="Edit description" onClick={() => setEditingBody(true)} size="icon-xs" variant="ghost"><Codicon name="edit" size="0.7rem" /></Button></div>
          {editingBody ? (
            <div className="hkg-body-editor-wrap">
              <Textarea autoFocus className="hkg-body-editor" onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraftBody(event.target.value)} placeholder="Write task instructions or context…" value={draftBody} />
              <div className="hkg-inline-editor-actions">
                <Button disabled={savingContent} onClick={() => { setDraftBody(task.body || ''); setEditingBody(false) }} size="xs" variant="ghost">Cancel</Button>
                <Button disabled={savingContent} onClick={() => void saveBody()} size="xs" variant="primary">{savingContent ? <Loader size="xs" /> : 'Save'}</Button>
              </div>
            </div>
          ) : task.body ? <p className="hkg-description">{task.body}</p> : <p className="hkg-drawer-muted">No description yet.</p>}
        </section>
        {task.result && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">Result</div>
            <p className="hkg-description">{task.result}</p>
          </section>
        )}
        {task.latest_summary && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">Latest summary</div>
            <p className="hkg-description">{task.latest_summary}</p>
          </section>
        )}
        {(parents.length > 0 || children.length > 0) && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">Dependencies</div>
            <DependencySide label="Blocked by" onSelect={onSelect} tasks={parents} />
            <DependencySide label="Blocks" onSelect={onSelect} tasks={children} />
          </section>
        )}
        <section className="hkg-drawer-section">
          <div className="hkg-section-label">Comments <span>{comments.length}</span></div>
          {comments.length > 0 && (
            <div className="hkg-comment-list">
              {comments.map(item => (
                <article key={item.id}>
                  <header><strong>{item.author}</strong><time>{new Date(item.created_at * 1000).toLocaleString()}</time></header>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          )}
          <div className="hkg-comment-composer">
            <Textarea onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setComment(event.target.value)} placeholder="Add a comment…" value={comment} />
            <Button disabled={savingComment || !comment.trim()} onClick={() => void addComment()} size="xs" variant="primary">
              {savingComment ? <Loader size="xs" /> : <Codicon name="send" size="0.7rem" />}Comment
            </Button>
          </div>
        </section>
        {events.length > 0 && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">Activity <span>{events.length}</span></div>
            <div className="hkg-activity-list">
              {events.slice(-8).reverse().map(event => (
                <div key={event.id}><Codicon name="history" size="0.65rem" /><span>{event.kind.replaceAll('_', ' ')}</span><time>{new Date(event.created_at * 1000).toLocaleString()}</time></div>
              ))}
            </div>
          </section>
        )}
        </>}
      </div>
    </aside>
  )
}

export function RefreshButton({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  return (
    <Tip label="Refresh graph">
      <Button aria-label="Refresh graph" onClick={onRefresh} size="icon-xs" variant="ghost">
        <Codicon name="refresh" size="0.85rem" spinning={refreshing} />
      </Button>
    </Tip>
  )
}
