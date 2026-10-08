/**
 * Plugin-scoped copy (ctx.i18n.register + usePluginI18n). Status labels match
 * the bundled Kanban board's own translations so both views use one vocabulary.
 */

type Fn = (...args: never[]) => string
interface Tree { [key: string]: Fn | string | Tree }

const en = {
  title: 'Kanban Graph',
  nav: 'Kanban Graph',
  paletteOpen: 'Open Kanban Graph',
  status: {
    triage: 'Triage',
    todo: 'Todo',
    scheduled: 'Scheduled',
    ready: 'Ready',
    running: 'Running',
    blocked: 'Blocked',
    review: 'Review',
    done: 'Done',
    archived: 'Archived'
  },
  toolbar: {
    filterTasks: 'Filter tasks',
    filterGraph: 'Filter graph',
    refresh: 'Refresh graph',
    settings: 'Graph settings',
    statTip: (total: number, linked: number, unlinked: number) => `${total} tasks · ${linked} linked · ${unlinked} unlinked`,
    unlinkedShort: (count: number) => `${count} unlinked`,
    chipTip: (label: string, count: number) => `${count} ${label} — click to filter`
  },
  board: {
    label: 'Kanban board',
    follow: 'Follow Kanban',
    followHint: (name: string) => `Same board as the Kanban page (${name})`,
    boards: 'Boards',
    count: (count: number) => `${count}`,
    following: 'Following the Kanban page'
  },
  filter: {
    status: 'Status',
    allStatuses: 'All statuses',
    assignee: 'Assignee',
    allProfiles: 'All profiles',
    tenant: 'Tenant',
    allTenants: 'All tenants',
    linkedOnly: 'Linked tasks only',
    showArchived: 'Show archived'
  },
  settings: {
    layout: 'Layout',
    horizontal: 'Horizontal',
    vertical: 'Vertical',
    connections: 'Connections',
    straight: 'Straight',
    elbow: 'Elbow',
    curve: 'Curve',
    hideImplied: 'Hide implied links',
    motion: 'Connection motion',
    minimap: 'MiniMap',
    grid: 'Dot grid',
    fit: 'Fit graph to view',
    reset: 'Reset positions'
  },
  section: {
    unlinked: 'Unlinked tasks',
    expand: 'Show unlinked tasks',
    collapse: 'Hide unlinked tasks'
  },
  node: {
    open: (title: string) => `Open task details: ${title}`,
    hiddenDeps: (count: number) => `${count} link(s) to hidden (archived) tasks`,
    unmet: (count: number) => `Waiting on ${count} unfinished prerequisite(s)`,
    links: (count: number) => `${count} dependency link(s)`,
    truncatedDeps: (count: number) => `${count} link(s) to tasks beyond the display limit`
  },
  canvas: {
    hint: 'Double-click canvas to fit',
    linked: (count: number) => `${count} linked`
  },
  state: {
    loadError: 'Could not load dependency graph',
    retry: 'Try again',
    noMatch: 'No matching tasks',
    noMatchHint: 'Clear filters to see the full graph.',
    clearFilters: 'Clear filters',
    empty: 'No tasks on this board',
    emptyHint: 'Create tasks and dependencies in Kanban to populate this view.',
    allArchived: (count: number) => `All ${count} tasks on this board are archived`,
    allArchivedHint: 'Archived tasks are hidden by default.',
    showArchived: 'Show archived tasks',
    notInitialized: 'This board has no database yet',
    notInitializedHint: 'It is created the first time a task is added in Kanban.',
    openKanban: 'Open Kanban',
    truncated: (shown: number, total: number) => `Showing the first ${shown} of ${total} tasks. Search and filters only cover these; links to the rest are counted on the cards.`,
    archivedHidden: (count: number) => `${count} archived hidden`,
    refreshing: 'Updating…',
    kanbanDisabled: 'The Kanban page is turned off. Enable the “Kanban” plugin in Settings ▸ Plugins to open it.'
  },
  inspector: {
    label: 'Task details',
    changeStatus: (status: string) => `Change task status. Current status: ${status}`,
    openKanban: 'Open full Kanban',
    close: 'Close details',
    editTitle: 'Edit title',
    cancel: 'Cancel',
    save: 'Save',
    retry: 'Retry',
    loading: 'Loading full task…',
    assignee: 'Assignee',
    unassigned: 'Unassigned',
    priority: 'Priority',
    tenant: 'Tenant',
    none: 'None',
    createdBy: 'Created by',
    created: 'Created',
    description: 'Description',
    editDescription: 'Edit description',
    descriptionPlaceholder: 'Write task instructions or context…',
    noDescription: 'No description yet.',
    result: 'Result',
    latestSummary: 'Latest summary',
    dependencies: 'Dependencies',
    blockedBy: 'Blocked by',
    blocks: 'Blocks',
    hiddenDeps: (count: number) => `${count} more link(s) to archived tasks — enable “Show archived” to see them.`,
    truncatedDeps: (count: number) => `${count} more link(s) to tasks beyond the display limit.`,
    openKanbanOther: (name: string) => `Open Kanban (it shows board “${name}”, not this one)`,
    comments: 'Comments',
    commentPlaceholder: 'Add a comment…',
    comment: 'Comment',
    activity: 'Activity',
    completeTitle: 'Complete task',
    completeHint: 'Kanban needs a short result summary to mark a task done.',
    completePlaceholder: 'What was done? (visible to dependent tasks)',
    complete: 'Mark done'
  },
  toast: {
    updated: 'Task updated in Kanban.',
    updateFailed: (error: string) => `Could not update task: ${error}`,
    commented: 'Comment added. The Kanban worker can see this note.',
    commentFailed: (error: string) => `Could not add comment: ${error}`,
    moved: (status: string) => `Task moved to ${status}.`,
    moveFailed: (error: string) => `Could not change status: ${error}`,
    staleConnection: 'The connection changed. Reopen the task and try again.'
  }
} satisfies Tree

type Messages = typeof en

const zh: Messages = {
  title: '看板依赖图',
  nav: '看板依赖图',
  paletteOpen: '打开看板依赖图',
  status: {
    triage: '分诊',
    todo: '待办',
    scheduled: '已排期',
    ready: '就绪',
    running: '运行中',
    blocked: '受阻',
    review: '审查',
    done: '完成',
    archived: '已归档'
  },
  toolbar: {
    filterTasks: '筛选任务',
    filterGraph: '筛选',
    refresh: '刷新',
    settings: '图设置',
    statTip: (total, linked, unlinked) => `共 ${total} 个任务 · ${linked} 个有依赖 · ${unlinked} 个独立`,
    unlinkedShort: count => `${count} 个独立`,
    chipTip: (label, count) => `${label} ${count} 个 — 点击筛选`
  },
  board: {
    label: '看板',
    follow: '跟随看板页面',
    followHint: name => `与看板页面相同（${name}）`,
    boards: '看板列表',
    count: count => `${count}`,
    following: '正在跟随看板页面'
  },
  filter: {
    status: '状态',
    allStatuses: '全部状态',
    assignee: '负责人',
    allProfiles: '全部配置档',
    tenant: '租户',
    allTenants: '全部租户',
    linkedOnly: '只看有依赖的任务',
    showArchived: '显示已归档'
  },
  settings: {
    layout: '布局',
    horizontal: '横向',
    vertical: '纵向',
    connections: '连线',
    straight: '直线',
    elbow: '折线',
    curve: '曲线',
    hideImplied: '隐藏可推导的连线',
    motion: '连线动画',
    minimap: '小地图',
    grid: '点状网格',
    fit: '适应窗口',
    reset: '重置位置'
  },
  section: {
    unlinked: '独立任务（无依赖）',
    expand: '展开独立任务',
    collapse: '收起独立任务'
  },
  node: {
    open: title => `打开任务详情：${title}`,
    hiddenDeps: count => `${count} 条依赖指向已隐藏（归档）的任务`,
    unmet: count => `等待 ${count} 个未完成的前置任务`,
    links: count => `${count} 条依赖`,
    truncatedDeps: count => `${count} 条依赖指向超出显示上限的任务`
  },
  canvas: {
    hint: '双击画布适应窗口',
    linked: count => `${count} 个有依赖`
  },
  state: {
    loadError: '无法加载依赖图',
    retry: '重试',
    noMatch: '没有匹配的任务',
    noMatchHint: '清除筛选条件以查看完整的图。',
    clearFilters: '清除筛选',
    empty: '这个看板还没有任务',
    emptyHint: '在看板中创建任务和依赖后会显示在这里。',
    allArchived: count => `这个看板的 ${count} 个任务都已归档`,
    allArchivedHint: '默认隐藏已归档任务。',
    showArchived: '显示已归档任务',
    notInitialized: '这个看板还没有数据库',
    notInitializedHint: '在看板中添加第一个任务时会自动创建。',
    openKanban: '打开看板',
    truncated: (shown, total) => `仅显示 ${total} 个任务中的前 ${shown} 个；搜索和筛选只作用于这些任务，指向其余任务的依赖在卡片上计数。`,
    archivedHidden: count => `已隐藏 ${count} 个归档`,
    refreshing: '正在更新…',
    kanbanDisabled: '看板页面未启用。请在 设置 ▸ 插件 中启用“Kanban”插件后再打开。'
  },
  inspector: {
    label: '任务详情',
    changeStatus: status => `更改任务状态。当前状态：${status}`,
    openKanban: '在看板中打开',
    close: '关闭详情',
    editTitle: '编辑标题',
    cancel: '取消',
    save: '保存',
    retry: '重试',
    loading: '正在加载任务…',
    assignee: '负责人',
    unassigned: '未分配',
    priority: '优先级',
    tenant: '租户',
    none: '无',
    createdBy: '创建者',
    created: '创建时间',
    description: '描述',
    editDescription: '编辑描述',
    descriptionPlaceholder: '填写任务说明或背景…',
    noDescription: '暂无描述。',
    result: '结果',
    latestSummary: '最新摘要',
    dependencies: '依赖关系',
    blockedBy: '前置任务',
    blocks: '后续任务',
    hiddenDeps: count => `另有 ${count} 条依赖指向已归档任务 — 打开“显示已归档”即可查看。`,
    truncatedDeps: count => `另有 ${count} 条依赖指向超出显示上限的任务。`,
    openKanbanOther: name => `打开看板（显示的是「${name}」，不是当前看板）`,
    comments: '评论',
    commentPlaceholder: '添加评论…',
    comment: '评论',
    activity: '动态',
    completeTitle: '完成任务',
    completeHint: '看板要求填写简短的结果摘要才能标记完成。',
    completePlaceholder: '完成了什么？（后续任务可以看到）',
    complete: '标记完成'
  },
  toast: {
    updated: '任务已在看板中更新。',
    updateFailed: error => `无法更新任务：${error}`,
    commented: '评论已添加，看板 worker 可以看到。',
    commentFailed: error => `无法添加评论：${error}`,
    moved: status => `任务已移到「${status}」。`,
    moveFailed: error => `无法更改状态：${error}`,
    staleConnection: '连接已切换，请重新打开任务后再试。'
  }
}

export const LOCALES = { en, zh } as Record<string, Tree>
export type { Messages }
