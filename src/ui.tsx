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
  Tip,
  usePluginI18n,
  type PluginTranslate
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
import { memo, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

import {
  FOLLOW_KANBAN,
  isAdminSummary,
  statusMeta,
  TASK_STATUSES,
  type EdgeStyle,
  type GraphFilters,
  type GraphTask,
  type LayoutDirection,
  type SectionNode,
  type StatusEdgeData,
  type TaskComment,
  type TaskEvent,
  type TaskNode
} from './graph'

export const PLUGIN_ID = 'kanban-graph'
export const useT = (): PluginTranslate => usePluginI18n(PLUGIN_ID)
export { statusMeta }

export interface BoardMeta {
  slug: string
  name?: string | null
  icon?: string | null
  archived?: boolean
  is_current?: boolean
  initialized?: boolean
  total?: number
  by_status?: Record<string, number>
}

export interface ViewSettings {
  direction: LayoutDirection
  edgeStyle: EdgeStyle
  showGrid: boolean
  showMiniMap: boolean
  showMotion: boolean
  hideImplied: boolean
}

/** Localized status label; unknown statuses fall back to a capitalized slug. */
export function statusLabel(t: PluginTranslate, status: string): string {
  const key = `status.${status}`
  const label = t(key)
  return label && label !== key ? label : status.charAt(0).toUpperCase() + status.slice(1)
}

const shortId = (id: string) => id.replace(/^t_/, '').slice(0, 6)

function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-./]+/).filter(Boolean)
  // Array.from keeps CJK / emoji code points intact.
  return `${Array.from(parts[0] ?? '?')[0] ?? '?'}${Array.from(parts[1] ?? '')[0] ?? ''}`.toUpperCase()
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
        className={cn('hkg-status-edge-base', `hkg-status-edge-${edgeData.activity}`, edgeData.implied && 'hkg-status-edge-implied')}
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
  const t = useT()
  const vertical = data._layoutDirection === 'TB'
  const meta = statusMeta(data.status)
  const latest = data.latest_summary && !isAdminSummary(data.latest_summary) ? data.latest_summary : ''
  const summary = latest || data.body
  const linkCount = Number(data._linkCount ?? 0)
  const unmet = Number(data._unmet ?? 0)
  const hidden = Number(data.hidden_parent_count ?? 0) + Number(data.hidden_child_count ?? 0)
  const truncated = Number(data.truncated_parent_count ?? 0) + Number(data.truncated_child_count ?? 0)

  return (
    <div
      className={cn('hkg-node', selected && 'hkg-node-selected')}
      data-status={data.status}
      style={{ '--hkg-tone': meta.tone } as CSSProperties}
    >
      {Boolean(data._linked) && <Handle isConnectable={false} position={vertical ? Position.Top : Position.Left} type="target" />}
      <div className="hkg-node-title" title={data.title || data.id}>{data.title || data.id}</div>
      {summary && <div className="hkg-node-summary">{summary}</div>}
      <div className="hkg-node-footer">
        <span className="hkg-node-status">
          <Codicon name={meta.icon} size="0.65rem" spinning={data.status === 'running'} />
          {statusLabel(t, data.status)}
        </span>
        {data.assignee && <Avatar name={data.assignee} />}
        <div className="hkg-node-meta">
          {unmet > 0 && <span className="hkg-node-unmet" title={t('node.unmet', unmet)}><Codicon name="debug-pause" size="0.65rem" />{unmet}</span>}
          {hidden > 0 && <span className="hkg-node-hidden" title={t('node.hiddenDeps', hidden)}><Codicon name="eye-closed" size="0.65rem" />{hidden}</span>}
          {truncated > 0 && <span className="hkg-node-hidden" title={t('node.truncatedDeps', truncated)}><Codicon name="ellipsis" size="0.65rem" />{truncated}</span>}
          {data.priority !== 0 && <span className="hkg-priority"><Codicon name="arrow-up" size="0.65rem" />{data.priority}</span>}
          {linkCount > 0 && <span title={t('node.links', linkCount)}><Codicon name="references" size="0.65rem" />{linkCount}</span>}
          <span className="hkg-short-id">{shortId(data.id)}</span>
        </div>
      </div>
      {Boolean(data._linked) && <Handle isConnectable={false} position={vertical ? Position.Bottom : Position.Right} type="source" />}
    </div>
  )
}

function SectionHeaderView({ data }: NodeProps<SectionNode>) {
  const t = useT()
  return (
    <div className="hkg-section" style={{ width: data.width }} title={t(data.collapsed ? 'section.expand' : 'section.collapse')}>
      <Codicon name={data.collapsed ? 'chevron-right' : 'chevron-down'} size="0.8rem" />
      <span>{t('section.unlinked')}</span>
      <span className="hkg-section-count">{data.count}</span>
      <span className="hkg-section-rule" />
    </div>
  )
}

export const NODE_TYPES = { task: memo(TaskCardView), section: memo(SectionHeaderView) }
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
  const t = useT()
  const active = Boolean(filters.status || filters.assignee || filters.tenant || filters.linkedOnly || includeArchived)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t('toolbar.filterGraph')} className={cn(active && 'hkg-control-active')} size="icon-xs" variant="ghost">
          <Codicon name="filter" size="0.85rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="hkg-filter-menu">
        <MenuLabel>{t('filter.status')}</MenuLabel>
        <DropdownMenuItem onSelect={() => onChange({ status: '' })}>{t('filter.allStatuses')}<Check active={!filters.status} /></DropdownMenuItem>
        {TASK_STATUSES.map(status => {
          const meta = statusMeta(status)
          return (
            <DropdownMenuItem
              key={status}
              onSelect={() => {
                // Archived cards are not fetched unless asked for.
                if (status === 'archived' && !includeArchived) onArchived(true)
                onChange({ status })
              }}
            >
              <span className="hkg-status-dot" style={{ backgroundColor: meta.tone }} />
              {statusLabel(t, status)}
              <Check active={filters.status === status} />
            </DropdownMenuItem>
          )
        })}
        {assignees.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <MenuLabel>{t('filter.assignee')}</MenuLabel>
            <DropdownMenuItem onSelect={() => onChange({ assignee: '' })}>{t('filter.allProfiles')}<Check active={!filters.assignee} /></DropdownMenuItem>
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
            <MenuLabel>{t('filter.tenant')}</MenuLabel>
            <DropdownMenuItem onSelect={() => onChange({ tenant: '' })}>{t('filter.allTenants')}<Check active={!filters.tenant} /></DropdownMenuItem>
            {tenants.map(name => <DropdownMenuItem key={name} onSelect={() => onChange({ tenant: name })}>{name}<Check active={filters.tenant === name} /></DropdownMenuItem>)}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onChange({ linkedOnly: !filters.linkedOnly })}>
          {t('filter.linkedOnly')}<Check active={Boolean(filters.linkedOnly)} />
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            if (includeArchived && filters.status === 'archived') onChange({ status: '' })
            onArchived(!includeArchived)
          }}
        >
          {t('filter.showArchived')}<Check active={includeArchived} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Clickable per-status counts, like the Kanban lane headers. */
export function StatusChips({ active, counts, onToggle }: {
  active: string
  counts: { status: string; count: number }[]
  onToggle: (status: string) => void
}) {
  const t = useT()
  if (counts.length === 0) return null
  return (
    <div className="hkg-chips" role="group">
      {counts.map(({ count, status }) => {
        const label = statusLabel(t, status)
        return (
          <Tip key={status} label={t('toolbar.chipTip', label, count)}>
            <button
              aria-pressed={active === status}
              className={cn('hkg-chip', active === status && 'hkg-chip-active')}
              onClick={() => onToggle(status)}
              style={{ '--hkg-tone': statusMeta(status).tone } as CSSProperties}
              type="button"
            >
              <span className="hkg-status-dot" style={{ backgroundColor: statusMeta(status).tone }} />
              <span className="hkg-chip-label">{label}</span>
              <span className="hkg-chip-count">{count}</span>
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

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
  const t = useT()
  const [open, setOpen] = useState(false)
  const layoutOptions = [
    { id: 'LR', label: t('settings.horizontal') },
    { id: 'TB', label: t('settings.vertical') }
  ] as const
  const edgeOptions = [
    { id: 'straight', label: t('settings.straight') },
    { id: 'elbow', label: t('settings.elbow') },
    { id: 'curve', label: t('settings.curve') }
  ] as const
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button aria-label={t('toolbar.settings')} className={cn(open && 'hkg-control-active')} size="icon-xs" variant="ghost">
          <Codicon name="settings-gear" size="0.85rem" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="hkg-settings-popover">
        <div className="hkg-setting-group">
          <div className="hkg-setting-label">{t('settings.layout')}</div>
          <SegmentedControl className="hkg-segmented" onChange={direction => onChange({ direction })} options={layoutOptions} value={settings.direction} />
        </div>
        <div className="hkg-setting-group">
          <div className="hkg-setting-label">{t('settings.connections')}</div>
          <SegmentedControl className="hkg-segmented" onChange={edgeStyle => onChange({ edgeStyle })} options={edgeOptions} value={settings.edgeStyle} />
        </div>
        <div className="hkg-setting-group hkg-setting-toggles">
          <ToggleRow checked={settings.hideImplied} label={t('settings.hideImplied')} onChange={hideImplied => onChange({ hideImplied })} />
          <ToggleRow checked={settings.showMotion} label={t('settings.motion')} onChange={showMotion => onChange({ showMotion })} />
          <ToggleRow checked={settings.showMiniMap} label={t('settings.minimap')} onChange={showMiniMap => onChange({ showMiniMap })} />
          <ToggleRow checked={settings.showGrid} label={t('settings.grid')} onChange={showGrid => onChange({ showGrid })} />
        </div>
        <div className="hkg-settings-actions">
          <Button className="hkg-fit-button" onClick={() => { onFit(); setOpen(false) }} size="xs" variant="outline">
            <Codicon name="screen-full" size="0.75rem" />{t('settings.fit')}
          </Button>
          <Button disabled={!hasManualPositions} onClick={() => { onResetPositions(); setOpen(false) }} size="xs" variant="ghost">
            <Codicon name="discard" size="0.75rem" />{t('settings.reset')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const boardLabel = (board: BoardMeta | undefined, fallback: string) => board?.name || board?.slug || fallback

export function BoardSwitcher({ boards, followedSlug, onChange, selection }: {
  boards: BoardMeta[]
  followedSlug: string
  onChange: (selection: string) => void
  selection: string
}) {
  const t = useT()
  if (boards.length === 0) return null
  const followed = boards.find(board => board.slug === followedSlug)
  const value = selection === FOLLOW_KANBAN || !boards.some(board => board.slug === selection) ? FOLLOW_KANBAN : selection
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label={t('board.label')} className="hkg-board-switcher" size="xs">
        <Codicon name={value === FOLLOW_KANBAN ? 'link' : 'project'} size="0.75rem" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FOLLOW_KANBAN}>
          <span className="hkg-board-option">
            <span className="hkg-board-option-name">{t('board.follow')} · {boardLabel(followed, followedSlug)}</span>
            {typeof followed?.total === 'number' && <span className="hkg-board-option-count">{followed.total}</span>}
          </span>
        </SelectItem>
        {boards.map(board => (
          <SelectItem key={board.slug} value={board.slug}>
            <span className="hkg-board-option">
              <span className="hkg-board-option-name">{boardLabel(board, board.slug)}</span>
              {typeof board.total === 'number' && <span className="hkg-board-option-count">{board.total}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MetaRow({ children, label }: { children: ReactNode; label: string }) {
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

function StatusMenu({ disabled, onChange, status, targets }: {
  disabled: boolean
  onChange: (status: string) => void
  status: string
  /** Current status plus the moves core accepts from it (see `statusTargets`). */
  targets: readonly string[]
}) {
  const t = useT()
  const meta = statusMeta(status)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t('inspector.changeStatus', statusLabel(t, status))}
          className="hkg-status-menu-trigger"
          disabled={disabled}
          style={{ backgroundColor: `color-mix(in srgb, ${meta.tone} 15%, transparent)`, color: meta.tone }}
          type="button"
        >
          <span className="hkg-status-dot" style={{ backgroundColor: meta.tone }} />
          {statusLabel(t, status)}
          {disabled ? <Loader size="xs" /> : <Codicon name="chevron-down" size="0.7rem" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {targets.map(target => {
          const targetMeta = statusMeta(target)
          return (
            <DropdownMenuItem key={target} onSelect={() => target !== status && onChange(target)}>
              <span className="hkg-status-dot" style={{ backgroundColor: targetMeta.tone }} />
              {statusLabel(t, target)}
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
  openKanbanLabel,
  onRetry,
  onSaveContent,
  onSelect,
  parents,
  savingComment,
  savingContent,
  savingStatus,
  statusTargets,
  task
}: {
  children: GraphTask[]
  comments: TaskComment[]
  detailError: string
  detailLoading: boolean
  detailReady: boolean
  events: TaskEvent[]
  onAddComment: (body: string) => Promise<boolean>
  onChangeStatus: (status: string, summary?: string) => Promise<boolean>
  onClose: () => void
  onOpenKanban: () => void
  openKanbanLabel: string
  onRetry: () => void
  onSaveContent: (patch: { title?: string; body?: string }) => Promise<boolean>
  onSelect: (task: GraphTask) => void
  parents: GraphTask[]
  savingComment: boolean
  savingContent: boolean
  savingStatus: boolean
  statusTargets: readonly string[]
  task: GraphTask
}) {
  const t = useT()
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)
  const [draftBody, setDraftBody] = useState(task.body || '')
  const [comment, setComment] = useState('')
  const [completing, setCompleting] = useState(false)
  const [completionSummary, setCompletionSummary] = useState('')

  useEffect(() => {
    if (editingTitle) return
    setDraftTitle(task.title)
  }, [editingTitle, task.id, task.title])

  useEffect(() => {
    if (editingBody) return
    setDraftBody(task.body || '')
  }, [editingBody, task.body, task.id])

  // The latest drafts, read after an await: a save that resolves late must not
  // close an editor or clear a composer the user has typed into since.
  const latest = useRef({ body: draftBody, comment, title: draftTitle })
  latest.current = { body: draftBody, comment, title: draftTitle }

  const saveTitle = async () => {
    const title = draftTitle.trim()
    if (!title) return
    if (await onSaveContent({ title }) && latest.current.title.trim() === title) setEditingTitle(false)
  }
  const saveBody = async () => {
    const body = draftBody
    if (await onSaveContent({ body }) && latest.current.body === body) setEditingBody(false)
  }
  const addComment = async () => {
    const body = comment.trim()
    if (!body) return
    if (await onAddComment(body)) setComment(current => (current.trim() === body ? '' : current))
  }
  const cancelTitle = () => {
    setDraftTitle(task.title)
    setEditingTitle(false)
  }
  const cancelBody = () => {
    setDraftBody(task.body || '')
    setEditingBody(false)
  }
  const cancelCompletion = () => {
    setCompleting(false)
    setCompletionSummary('')
  }
  // Escape inside an editor cancels that editor only; the drawer stays open.
  const onEscape = (cancel: () => void, submit?: () => void, plainEnter = false) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' && submit && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.shiftKey && (plainEnter || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const requestStatus = (status: string) => {
    // Kanban refuses to complete a card without result evidence unless it is
    // approved out of review or already carries a result.
    if (status === 'done' && task.status !== 'review' && !String(task.result ?? '').trim()) {
      setCompleting(true)
      return
    }
    void onChangeStatus(status)
  }
  const submitCompletion = async () => {
    const summary = completionSummary.trim()
    if (!summary) return
    if (await onChangeStatus('done', summary)) {
      setCompleting(false)
      setCompletionSummary(current => (current.trim() === summary ? '' : current))
    }
  }
  const hiddenLinks = Number(task.hidden_parent_count ?? 0) + Number(task.hidden_child_count ?? 0)
  const truncatedLinks = Number(task.truncated_parent_count ?? 0) + Number(task.truncated_child_count ?? 0)
  const latestSummary = task.latest_summary && !isAdminSummary(task.latest_summary) ? task.latest_summary : ''

  return (
    <aside className="hkg-inspector" aria-label={t('inspector.label')}>
      <header className="hkg-inspector-head">
        <div className="hkg-inspector-topline">
          <div className="hkg-inspector-status-row">
            {detailReady && <StatusMenu disabled={savingStatus} onChange={requestStatus} status={task.status} targets={statusTargets} />}
            <span className="hkg-task-id">{shortId(task.id)}</span>
          </div>
          <div className="hkg-inspector-head-actions">
            <CopyButton appearance="icon" buttonSize="icon-xs" text={task.id} />
            <Tip label={openKanbanLabel}><Button aria-label={openKanbanLabel} onClick={onOpenKanban} size="icon-xs" variant="ghost"><Codicon name="project" /></Button></Tip>
            <Button aria-label={t('inspector.close')} onClick={onClose} size="icon-xs" variant="ghost"><Codicon name="close" /></Button>
          </div>
        </div>
        {detailReady && (editingTitle ? (
          <div className="hkg-title-editor" onKeyDown={onEscape(cancelTitle)}>
            <Input autoFocus onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftTitle(event.target.value)} onKeyDown={onEscape(cancelTitle, () => { if (!savingContent && draftTitle.trim()) void saveTitle() }, true)} value={draftTitle} />
            <div className="hkg-inline-editor-actions">
              <Button disabled={savingContent} onClick={cancelTitle} size="xs" variant="ghost">{t('inspector.cancel')}</Button>
              <Button disabled={savingContent || !draftTitle.trim()} onClick={() => void saveTitle()} size="xs" variant="primary">{savingContent ? <Loader size="xs" /> : t('inspector.save')}</Button>
            </div>
          </div>
        ) : (
          <div className="hkg-title-row"><h2>{task.title || task.id}</h2><Button aria-label={t('inspector.editTitle')} onClick={() => setEditingTitle(true)} size="icon-xs" variant="ghost"><Codicon name="edit" /></Button></div>
        ))}
        {completing && (
          <div className="hkg-complete-form" onKeyDown={onEscape(cancelCompletion)}>
            <div className="hkg-section-label">{t('inspector.completeTitle')}</div>
            <p className="hkg-drawer-muted">{t('inspector.completeHint')}</p>
            <Textarea autoFocus onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setCompletionSummary(event.target.value)} onKeyDown={onEscape(cancelCompletion, () => void submitCompletion())} placeholder={t('inspector.completePlaceholder')} value={completionSummary} />
            <div className="hkg-inline-editor-actions">
              <Button disabled={savingStatus} onClick={cancelCompletion} size="xs" variant="ghost">{t('inspector.cancel')}</Button>
              <Button disabled={savingStatus || !completionSummary.trim()} onClick={() => void submitCompletion()} size="xs" variant="primary">{savingStatus ? <Loader size="xs" /> : t('inspector.complete')}</Button>
            </div>
          </div>
        )}
      </header>
      <div className="hkg-inspector-scroll">
        {detailError ? (
          <div className="hkg-detail-state hkg-detail-error"><Codicon name="warning" /><span>{detailError}</span><Button onClick={onRetry} size="xs" variant="outline">{t('inspector.retry')}</Button></div>
        ) : detailLoading || !detailReady ? (
          <div className="hkg-detail-state hkg-detail-loading"><Loader size="sm" /><span>{t('inspector.loading')}</span></div>
        ) : <>
        <dl className="hkg-inspector-grid">
          <MetaRow label={t('inspector.assignee')}>{task.assignee ? <span className="hkg-inline-meta"><Avatar name={task.assignee} />{task.assignee}</span> : <span className="hkg-drawer-muted">{t('inspector.unassigned')}</span>}</MetaRow>
          <MetaRow label={t('inspector.priority')}>P{task.priority}</MetaRow>
          <MetaRow label={t('inspector.tenant')}>{task.tenant || <span className="hkg-drawer-muted">{t('inspector.none')}</span>}</MetaRow>
          {task.created_by && <MetaRow label={t('inspector.createdBy')}>{task.created_by}</MetaRow>}
          {task.created_at && <MetaRow label={t('inspector.created')}><time>{new Date(task.created_at * 1000).toLocaleString()}</time></MetaRow>}
        </dl>
        <section className="hkg-drawer-section hkg-description-section">
          <div className="hkg-section-label">{t('inspector.description')}<Button aria-label={t('inspector.editDescription')} onClick={() => setEditingBody(true)} size="icon-xs" variant="ghost"><Codicon name="edit" size="0.7rem" /></Button></div>
          {editingBody ? (
            <div className="hkg-body-editor-wrap" onKeyDown={onEscape(cancelBody)}>
              <Textarea autoFocus className="hkg-body-editor" onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraftBody(event.target.value)} onKeyDown={onEscape(cancelBody, () => { if (!savingContent) void saveBody() })} placeholder={t('inspector.descriptionPlaceholder')} value={draftBody} />
              <div className="hkg-inline-editor-actions">
                <Button disabled={savingContent} onClick={cancelBody} size="xs" variant="ghost">{t('inspector.cancel')}</Button>
                <Button disabled={savingContent} onClick={() => void saveBody()} size="xs" variant="primary">{savingContent ? <Loader size="xs" /> : t('inspector.save')}</Button>
              </div>
            </div>
          ) : task.body ? <p className="hkg-description">{task.body}</p> : <p className="hkg-drawer-muted">{t('inspector.noDescription')}</p>}
        </section>
        {task.result && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">{t('inspector.result')}</div>
            <p className="hkg-description">{task.result}</p>
          </section>
        )}
        {latestSummary && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">{t('inspector.latestSummary')}</div>
            <p className="hkg-description">{latestSummary}</p>
          </section>
        )}
        {(parents.length > 0 || children.length > 0 || hiddenLinks > 0 || truncatedLinks > 0) && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">{t('inspector.dependencies')}</div>
            <DependencySide label={t('inspector.blockedBy')} onSelect={onSelect} tasks={parents} />
            <DependencySide label={t('inspector.blocks')} onSelect={onSelect} tasks={children} />
            {hiddenLinks > 0 && <p className="hkg-drawer-muted hkg-hidden-note"><Codicon name="eye-closed" size="0.7rem" />{t('inspector.hiddenDeps', hiddenLinks)}</p>}
            {truncatedLinks > 0 && <p className="hkg-drawer-muted hkg-hidden-note"><Codicon name="ellipsis" size="0.7rem" />{t('inspector.truncatedDeps', truncatedLinks)}</p>}
          </section>
        )}
        <section className="hkg-drawer-section">
          <div className="hkg-section-label">{t('inspector.comments')} <span>{comments.length}</span></div>
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
            <Textarea onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setComment(event.target.value)} onKeyDown={onEscape(() => (document.activeElement as HTMLElement | null)?.blur(), () => { if (!savingComment && comment.trim()) void addComment() })} placeholder={t('inspector.commentPlaceholder')} value={comment} />
            <Button disabled={savingComment || !comment.trim()} onClick={() => void addComment()} size="xs" variant="primary">
              {savingComment ? <Loader size="xs" /> : <Codicon name="send" size="0.7rem" />}{t('inspector.comment')}
            </Button>
          </div>
        </section>
        {events.length > 0 && (
          <section className="hkg-drawer-section">
            <div className="hkg-section-label">{t('inspector.activity')} <span>{events.length}</span></div>
            <div className="hkg-activity-list">
              {events.filter(event => event.kind !== 'heartbeat').slice(-8).reverse().map(event => (
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
  const t = useT()
  return (
    <Tip label={t('toolbar.refresh')}>
      <Button aria-label={t('toolbar.refresh')} onClick={onRefresh} size="icon-xs" variant="ghost">
        <Codicon name="refresh" size="0.85rem" spinning={refreshing} />
      </Button>
    </Tip>
  )
}
