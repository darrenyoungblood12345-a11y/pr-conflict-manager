import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentKind, Command, Scope, Snapshot, Task } from '../shared/contracts.js'
import './styles.css'
import { RepositoryPanel } from './RepositoryPanel.js'
import { AgentSetupPanel } from './AgentSetupPanel.js'
import { WorkspacePoolPanel } from './WorkspacePoolPanel.js'
import type { DesktopRuntime } from '../shared/desktop.js'
import './workspace-pool.css'

type View = 'workspace' | 'worktree' | 'activity' | 'agents' | 'pool'
type IconName = 'grid' | 'branch' | 'activity' | 'arrow' | 'plus' | 'file' | 'code' | 'close' | 'check' | 'warning'

const iconPaths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  branch: <><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M6 7.5v9M18 7.5v2a6 6 0 0 1-6 6H6" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></>,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3h.01" /></>,
}

const Icon = ({ name, size = 18 }: { name: IconName; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>
)

const agentNames: Record<AgentKind, string> = {
  codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', 'claude-code': 'Claude Code',
}
const heldStatuses = new Set(['active', 'blocked', 'awaiting-merge'])
const statusLabels: Record<Task['status'], string> = {
  active: 'Active', blocked: 'Pause requested', 'awaiting-merge': 'Awaiting merge',
  completed: 'Completed', cancelled: 'Cancelled',
}
const Status = ({ task }: { task: Task }) => (
  <span className={`task-status status-${task.status}`}><span className="status-dot" />{task.status === 'blocked' && task.stopAcknowledged ? task.conflicts.length ? 'Stopped · conflict' : 'Stopped' : statusLabels[task.status]}</span>
)

const cleanError = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  : 'The request could not be completed.'

const Empty = ({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) => (
  <div className="empty"><span className="empty-icon"><Icon name={icon} size={23} /></span><strong>{title}</strong><p>{children}</p></div>
)

const ScopeTree = ({ tasks, onSelect }: { tasks: Task[]; onSelect(task: Task): void }) => {
  const paths = [...new Set(tasks.flatMap((task) => task.scopes.map((scope) => scope.path)))].sort()
  if (!paths.length) return <Empty icon="code" title="A clear field">Reserved files and functions will appear here when work is registered.</Empty>
  return <div className="scope-tree">{paths.map((file) => (
    <details open key={file}>
      <summary><Icon name="file" size={16} /><span>{file}</span><span className="count">{tasks.filter((task) => task.scopes.some((scope) => scope.path === file)).length}</span></summary>
      <div className="scope-children">{tasks.flatMap((task) => task.scopes.filter((scope) => scope.path === file).map((scope, index) => (
        <button className="scope-leaf" key={`${task.id}-${index}`} onClick={() => onSelect(task)}>
          <span className={task.status === 'blocked' ? 'symbol conflict' : 'symbol'}>{scope.kind === 'file' ? '▧' : 'ƒ'}</span>
          <span className="scope-name">{scope.kind === 'file' ? 'Whole file' : scope.symbol}</span>
          <span className="scope-owner">{agentNames[task.agent]}</span>
        </button>
      )))}</div>
    </details>
  ))}</div>
}

const TaskForm = ({ task, planRevision, busy, authoritative, actionError, onClose, onSubmit }: {
  task?: Task; planRevision: number; busy: boolean; authoritative: boolean; actionError: string;
  onClose(): void; onSubmit(command: Command): Promise<boolean>;
}) => {
  const [description, setDescription] = useState(task?.description ?? '')
  const [branch, setBranch] = useState(task?.branch ?? '')
  const [baseCommit, setBaseCommit] = useState(task?.baseCommit ?? '')
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? 'local-user')
  const [agent, setAgent] = useState<AgentKind>(task?.agent ?? 'codex')
  const [scopes, setScopes] = useState(task?.scopes.map((scope) => scope.kind === 'file' ? scope.path : `${scope.path}::${scope.symbol}`).join('\n') ?? '')
  const [validation, setValidation] = useState('')
  const branchEdited = useRef(false)
  const baseEdited = useRef(false)

  useEffect(() => {
    if (task) return
    let active = true
    void window.workspace?.repository.snapshot().then(view => {
      if (!active) return
      if (!branchEdited.current) setBranch(current => current || view.local?.branch || '')
      if (!baseEdited.current) setBaseCommit(current => current || view.local?.head || '')
    }).catch(() => undefined)
    return () => { active = false }
  }, [task?.id])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const parsedScopes: Scope[] = scopes.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf('::')
      return separator < 0 ? { path: line, kind: 'file' } : {
        path: line.slice(0, separator).trim(), kind: 'symbol', symbol: line.slice(separator + 2).trim(),
      }
    })
    if (!description.trim() || !branch.trim() || !baseCommit.trim() || !ownerId.trim() ||
        !parsedScopes.length || parsedScopes.some((scope) => !scope.path || (scope.kind === 'symbol' && !scope.symbol))) {
      setValidation('Complete the task, branch, base commit, owner, and at least one valid scope.')
      return
    }
    const bytes = (value: string) => new TextEncoder().encode(value).length
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(ownerId.trim()) || !/^[a-fA-F0-9]{7,64}$/.test(baseCommit.trim())) {
      setValidation('Use an owner identifier up to 128 characters (letters, numbers, _, ., :, -) and a 7–64 character hexadecimal base commit.')
      return
    }
    if (bytes(description.trim()) > 8000 || bytes(branch.trim()) > 256 || parsedScopes.length > 256 ||
        parsedScopes.some(scope => bytes(scope.path) > 1024 || (scope.kind === 'symbol' && bytes(scope.symbol ?? '') > 512))) {
      setValidation('Keep the description within 8,000 UTF-8 bytes, branch within 256 bytes, and at most 256 scopes (path: 1,024 bytes; symbol: 512 bytes).')
      return
    }
    const proposal = {
      id: task?.id ?? crypto.randomUUID(), ownerId: ownerId.trim(), sessionId: task?.sessionId ?? 'desktop-local',
      agent, description: description.trim(), branch: branch.trim(), baseCommit: baseCommit.trim(), planRevision, scopes: parsedScopes,
    }
    const command: Command = task
      ? { type: 'revise_task', taskId: task.id, ownerId: task.ownerId, expectedRevision: task.revision, task: proposal }
      : { type: 'register_task', task: proposal }
    if (await onSubmit(command)) onClose()
  }

  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-title" onClick={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><span className="eyebrow">PLAN BEFORE YOU CHANGE</span><h2 id="proposal-title">{task ? 'Revise the approach' : 'Propose a task'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close proposal"><Icon name="close" /></button></div>
      <p className="modal-intro">Describe the intent and reserve the functions you need. A committed proposal can still be blocked by overlapping work.</p>
      <form onSubmit={submit}>
        <label>Task description<textarea autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What will change, why, and which shared interfaces are involved?" rows={3} maxLength={8000} required /></label>
        <div className="form-row"><label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Owner<input value={ownerId} readOnly={Boolean(task)} onChange={(event) => setOwnerId(event.target.value)} maxLength={128} required /></label></div>
        <div className="form-row"><label>Work branch<input value={branch} onChange={(event) => { branchEdited.current = true; setBranch(event.target.value) }} placeholder="feat/your-change" maxLength={256} required /></label><label>Base commit<input value={baseCommit} onChange={(event) => { baseEdited.current = true; setBaseCommit(event.target.value) }} placeholder="Git commit SHA (7–64 hex characters)" maxLength={64} required /></label></div>
        <label>Files and qualified functions<textarea className="mono" value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder={'src/example.ts::Example.save\nsrc/config.json'} rows={4} maxLength={400000} required /></label>
        <p className="field-hint">Choose this Mac’s GitHub clone in Worktree first. The first task binds that repository to this workspace. Branch/commit defaults come from the last local Git observation. One scope per line: <code>path::qualifiedFunction</code>, or a path for the entire file. Unsupported or uncertain scopes reserve the whole file. Check the registered scope after submission.</p>
        {validation && <p className="form-error" role="alert">{validation}</p>}
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        <div className="modal-footer"><span className="muted">Against shared plan r{planRevision}</span><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !authoritative} type="submit">{busy ? 'Submitting…' : task ? 'Submit revision' : 'Check & register'}<Icon name="arrow" size={16} /></button></div>
      </form>
    </section>
  </div>
}

const TaskDetail = ({ task, allTasks, busy, authoritative, actionError, onClose, onRevise, onCommand, onObservePr }: {
  task: Task; allTasks: Task[]; busy: boolean; authoritative: boolean; actionError: string;
  onClose(): void; onRevise(): void; onCommand(command: Command): Promise<boolean>;
  onObservePr(task: Task): Promise<string>;
}) => {
  const [prNumber, setPrNumber] = useState(task.pullRequest?.number.toString() ?? '')
  const [prMessage, setPrMessage] = useState('')
  useEffect(() => {
    setPrNumber(task.pullRequest?.number.toString() ?? '')
    setPrMessage('')
  }, [task.id, task.pullRequest?.number])
  const owned = { taskId: task.id, ownerId: task.ownerId, expectedRevision: task.revision }
  const held = heldStatuses.has(task.status)
  const linkPr = async () => {
    const number = Number(prNumber)
    if (!/^\d+$/.test(prNumber) || !Number.isSafeInteger(number) || number <= 0) {
      setPrMessage('Enter a positive GitHub PR number.')
      return
    }
    const accepted = await onCommand({ type: 'link_pull_request', ...owned, number })
    setPrMessage(accepted ? 'PR linked. Check GitHub to observe its merge status.' : 'The link was rejected. Review the current task and stop acknowledgement before replacing a link.')
  }
  return <div className="modal-backdrop" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="task-title" onClick={(event) => event.stopPropagation()}>
    <div className="modal-heading"><div><span className="eyebrow">TASK r{task.revision} · {agentNames[task.agent]}</span><h2 id="task-title">Task details</h2></div><button className="icon-button" onClick={onClose} aria-label="Close task"><Icon name="close" /></button></div>
    <Status task={task} /><p className="task-description">{task.description}</p>
    <dl className="task-facts"><div><dt>Owner</dt><dd>{task.ownerId}</dd></div><div><dt>Branch</dt><dd>{task.branch}</dd></div><div><dt>Declared base</dt><dd className="mono">{task.baseCommit}</dd></div><div><dt>Plan reviewed</dt><dd>Revision {task.planRevision}</dd></div><div><dt>Stop acknowledged</dt><dd>{task.stopAcknowledged ? 'Yes' : 'No'}</dd></div></dl>
    {task.status === 'blocked' && task.conflicts.length > 0 && <div className="conflict-notice"><Icon name="warning" /><div><strong>These plans overlap.</strong><p>Stop ongoing writes before acknowledging. Then cancel this task, or revise its scope after reviewing the competing work.</p>{task.conflicts.map((id) => <p key={id} className="conflict-reference">{allTasks.find((other) => other.id === id)?.description ?? id}</p>)}</div></div>}
    {task.status === 'blocked' && task.conflicts.length === 0 && task.stopAcknowledged && <p className="field-hint">Your writes are acknowledged as stopped. Revise the scope to request permission again, or abandon the task to release its reservations.</p>}
    <div className="detail-scopes"><span className="eyebrow">DECLARED RESERVATIONS</span>{task.scopes.map((scope, index) => <div key={index}><Icon name={scope.kind === 'file' ? 'file' : 'code'} size={16} /><code>{scope.path}{scope.kind === 'symbol' ? ` :: ${scope.symbol}` : ' · whole file'}</code></div>)}</div>
    {held && <><p className="field-hint">Desktop actions use the declared owner on this Mac; LAN tasks also require the originating device. Confirm stopped writes in the agent first. Reservations remain held until the service accepts a safe release.</p><div className="detail-actions">
      {!task.stopAcknowledged && <button className="button secondary" disabled={busy || !authoritative} onClick={() => void onCommand({ type: 'acknowledge_stop', ...owned })}>Confirm my writes have stopped</button>}
      <button className="button secondary" disabled={busy || !authoritative || !task.stopAcknowledged} onClick={onRevise}>Revise scope</button>
      <button className="button danger" disabled={busy || !authoritative || !task.stopAcknowledged} onClick={async () => { if (await onCommand({ type: 'cancel_task', ...owned })) onClose() }}>Abandon task</button>
      {(task.status === 'active' || task.stopAcknowledged && task.status === 'blocked') && <button className="button primary" disabled={busy || !authoritative} onClick={() => void onCommand({ type: 'report_completion', ...owned })}>Report editing complete</button>}
    </div></>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    <div className="detail-pr">
      <span className="eyebrow">LINKED GITHUB PULL REQUEST</span>
      <p className="field-hint">{task.prMerged ? 'GitHub merge observed. Completion also requires reporting editing complete and acknowledging stopped writes.' : 'Scopes stay reserved until editing is complete, writes are acknowledged as stopped, and this exact PR is observed merged.'}</p>
      {held && <div className="detail-actions"><label>PR number<input aria-label="PR number" inputMode="numeric" value={prNumber} onChange={event => setPrNumber(event.target.value)} placeholder="42" maxLength={16} /></label><button className="button secondary" disabled={busy || !authoritative || Boolean(task.pullRequest && !task.stopAcknowledged)} onClick={() => void linkPr()}>{task.pullRequest ? 'Replace link' : 'Link PR'}</button></div>}
      {task.pullRequest && <div className="detail-actions"><span className="muted">PR #{task.pullRequest.number} · {task.prMerged ? 'Merge observed' : 'Merge not observed'}</span><button className="button secondary" disabled={busy || !authoritative} onClick={async () => {
        setPrMessage('Checking GitHub…')
        try { setPrMessage(await onObservePr(task)) } catch (error) { setPrMessage(cleanError(error)) }
      }}>Check GitHub</button></div>}
      {prMessage && <p className="field-hint" role="status">{prMessage}</p>}
    </div>
  </section></div>
}

const App = () => {
  const [view, setView] = useState<View>('workspace')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [runtime, setRuntime] = useState<DesktopRuntime>({ status: 'starting', message: 'Connecting to the local coordinator…', workspaceKey: 'local', workspaceName: 'Local workspace', mode: 'local' })
  const [connectionError, setConnectionError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [planDraft, setPlanDraft] = useState('')
  const [editingPlan, setEditingPlan] = useState(false)
  const [draftRevision, setDraftRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [proposal, setProposal] = useState<'new' | 'revise' | null>(null)
  const refreshing = useRef(false)
  const workspaceKey = useRef('local')

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    if (!window.workspace) {
      setRuntime(current => ({ ...current, status: 'unavailable', message: 'Desktop bridge unavailable. Open the Electron app to connect.' }))
      setConnectionError('The browser preview cannot access the native coordinator.')
      return
    }
    refreshing.current = true
    try {
      const info = await window.workspace.runtime()
      if (workspaceKey.current !== info.workspaceKey) {
        workspaceKey.current = info.workspaceKey
        setSnapshot(null)
        setSelectedId(null)
        setProposal(null)
        setEditingPlan(false)
        setPlanDraft('')
        setActionError('')
      }
      setRuntime(info)
      if (info.status !== 'ready') {
        setConnectionError(info.status === 'starting' ? '' : info.message)
        return
      }
      setSnapshot(await window.workspace.snapshot())
      setConnectionError('')
    } catch (error) {
      setConnectionError(cleanError(error))
    } finally {
      refreshing.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelectedId(null); setProposal(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const command = async (value: Command) => {
    if (!window.workspace) return false
    if (value.type === 'set_plan' && new TextEncoder().encode(value.markdown).length > 65536) {
      setActionError('Keep the shared plan within 65,536 UTF-8 bytes. Your draft is retained.')
      return false
    }
    setBusy(true)
    setActionError('')
    try {
      const result = await window.workspace.command(value, runtime.workspaceKey)
      if (!result.ok) throw new Error(result.error?.message ?? 'The coordinator rejected this request.')
      await refresh()
      return true
    } catch (error) {
      setActionError(cleanError(error))
      await refresh()
      return false
    } finally {
      setBusy(false)
    }
  }

  const observePr = async (task: Task) => {
    if (!window.workspace) throw new Error('The desktop bridge is unavailable.')
    setBusy(true)
    try {
      const observation = await window.workspace.repository.observeTaskPullRequest(task.id, task.revision, runtime.workspaceKey)
      await refresh()
      if (observation.status !== 'fresh') return observation.error?.message ?? 'GitHub state is unknown. Reservations are retained.'
      return observation.mergeVerified ? 'This exact PR is merged. The workspace recorded the observation.' : 'This PR is not verified merged. Reservations are retained.'
    } finally { setBusy(false) }
  }

  const tasks = Object.values(snapshot?.tasks ?? {})
  const heldTasks = tasks.filter((task) => heldStatuses.has(task.status))
  const blocked = tasks.filter((task) => task.status === 'blocked' && task.conflicts.length > 0)
  const active = tasks.filter((task) => task.status === 'active')
  const selected = tasks.find((task) => task.id === selectedId)
  const authoritative = Boolean(snapshot?.hasAuthority && !connectionError && runtime.status === 'ready')
  const stale = Boolean(snapshot && connectionError)
  const branches = [...new Set(tasks.map((task) => task.branch))]
  const events = [...(snapshot?.events ?? [])].reverse()

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setView('workspace') }}><span className="brand-icon"><Icon name="branch" size={21} /></span><span>Agent PR<span className="brand-light">Monitor</span></span></a>
      <div className="workspace-switch"><span className="workspace-monogram">L</span><div><strong>{runtime.workspaceName}</strong><span>{runtime.mode === 'lan' ? 'LAN collaboration' : 'Development workspace'}</span></div><span className="tiny-label">01</span></div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Workspace views">{([
        ['workspace', 'grid', 'Overview'], ['worktree', 'branch', 'Worktree'], ['agents', 'code', 'Agents'], ['activity', 'activity', 'Activity'], ['pool', 'branch', 'Workspace pool'],
      ] as const).map(([id, icon, label]) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id)}><Icon name={icon} /><span>{label}</span>{id === 'activity' && events.length > 0 && <span className="nav-count">{events.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="eyebrow">BUILT TO WORK TOGETHER</span><p>Shared intent.<br />Independent branches.</p><span className="hairline" /><div className="note-line"><span className="status-dot muted-dot" />{runtime.mode === 'lan' ? 'LAN workspace' : 'Local development'}</div><small>Choose your clone in Worktree. Open Workspace pool to connect Macs.</small></div>
      <div className="sidebar-bottom"><span className="avatar">L</span><div><strong>This Mac</strong><span>Local participant</span></div><span className="version">0.1</span></div>
    </aside>

    <main>
      <header className="topbar"><div className="breadcrumbs">{runtime.workspaceName} <span>/</span> <strong>{view === 'workspace' ? 'Overview' : view === 'worktree' ? 'Worktree' : view === 'agents' ? 'Agents' : view === 'pool' ? 'Workspace pool' : 'Activity'}</strong></div><div className={`connection ${authoritative ? 'connected' : ''}`}><span className="status-dot" />{authoritative ? 'Coordination authority verified' : connectionError ? 'Coordinator unavailable' : runtime.status === 'starting' ? 'Starting coordinator' : 'Waiting for authority'}</div></header>
      <div className="page-content">
        <div className="page-heading"><div><span className="eyebrow">{view === 'workspace' ? 'A PLACE FOR SHARED INTENT' : view === 'worktree' ? 'BRANCHES & RESERVED SCOPE' : view === 'agents' ? 'LOCAL AGENT CONNECTIONS' : view === 'pool' ? 'SHARED ACROSS YOUR MACS' : 'THE SHARED RECORD'}</span><h1>{view === 'workspace' ? 'Make room for good work.' : view === 'worktree' ? 'See where work meets.' : view === 'agents' ? 'Bring your own agent.' : view === 'pool' ? 'A workspace that moves with you.' : 'Every change has a story.'}</h1><p>{view === 'workspace' ? 'Plan together. Give every agent a clear space to work.' : view === 'worktree' ? 'Declared branches and reservations, directly from the coordinator.' : view === 'agents' ? 'Connect your existing tools to the shared plan and task gates.' : view === 'pool' ? 'Create, join, and reopen a password-protected LAN workspace.' : 'Committed coordination events, ordered by the shared log.'}</p></div><button className="button primary" disabled={!authoritative || busy} onClick={() => { setActionError(''); setProposal('new') }}><Icon name="plus" size={16} />Propose a task</button></div>
        {connectionError && <div className="banner warning-banner" role="status"><Icon name="warning" /><div><strong>{stale ? 'Saved view · coordination unavailable' : 'Local coordinator unavailable'}</strong><p>{connectionError} New tasks and updates are disabled.</p></div><button className="text-button" onClick={() => void refresh()}>Retry</button></div>}
        {actionError && <div className="banner error-banner" role="alert"><Icon name="warning" /><p>{actionError}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setActionError('')}><Icon name="close" size={16} /></button></div>}
        {view === 'workspace' && <div className="panel-foot" style={{ marginBottom: 22, border: '1px solid var(--line)', borderRadius: 5 }}><Icon name="branch" size={15} /><span>Workspace repository: <strong>{snapshot?.repository ? `${snapshot.repository.owner}/${snapshot.repository.repo}` : 'Not bound yet'}</strong>. {snapshot?.repository ? stale ? 'Last received binding.' : 'One immutable GitHub repository per workspace.' : 'The first registered task binds the selected clone’s GitHub origin.'}</span></div>}

        {view === 'workspace' && <>
          <div className="metrics"><div><span>Active tasks</span><strong>{snapshot ? String(active.length).padStart(2, '0') : '—'}</strong><small>With reserved scope</small></div><div><span>Needs attention</span><strong className={blocked.length ? 'amber' : ''}>{snapshot ? String(blocked.length).padStart(2, '0') : '—'}</strong><small>{blocked.length ? 'Overlapping work paused' : 'No reported conflicts'}</small></div><div><span>Reserved files</span><strong>{snapshot ? String(new Set(heldTasks.flatMap((task) => task.scopes.map((scope) => scope.path))).size).padStart(2, '0') : '—'}</strong><small>Across all held tasks</small></div><div><span>Shared plan</span><strong>{snapshot ? <><span className="metric-prefix">r</span>{snapshot.plan.revision}</> : '—'}</strong><small>{stale ? 'Last received revision' : 'Current committed revision'}</small></div></div>
          <div className="dashboard-grid"><div className="main-column">
            <section className="panel plan-panel"><div className="panel-heading"><div><span className="section-mark">01</span><h2>Shared plan</h2></div><div className="heading-actions"><span className="subtle-label">{snapshot ? `r${snapshot.plan.revision}` : 'Not loaded'}</span>{!editingPlan && <button className="text-button" disabled={!authoritative} onClick={() => { setPlanDraft(snapshot?.plan.markdown ?? ''); setDraftRevision(snapshot?.plan.revision ?? 0); setEditingPlan(true) }}>Edit plan <Icon name="arrow" size={14} /></button>}</div></div>
              {editingPlan ? <div className="plan-editor"><textarea aria-label="Shared plan" value={planDraft} onChange={(event) => setPlanDraft(event.target.value)} rows={8} placeholder="Document the project goal, boundaries, and shared decisions…" maxLength={65536} autoFocus />{draftRevision !== snapshot?.plan.revision && <p className="form-error">The shared plan changed while you edited. Your draft is retained; saving will require the current revision.</p>}<div className="editor-actions"><button className="button secondary" onClick={() => setEditingPlan(false)}>Discard draft</button><button className="button primary" disabled={busy || !authoritative || draftRevision !== snapshot?.plan.revision} onClick={async () => { if (await command({ type: 'set_plan', expectedRevision: draftRevision, markdown: planDraft })) setEditingPlan(false) }}>Save shared plan</button></div></div>
                : snapshot?.plan.markdown ? <pre className="plan-content">{snapshot.plan.markdown}</pre> : <div className="plan-empty"><span className="plan-glyph">“</span><div><h3>Start with a shared understanding.</h3><p>Write down the goal, decisions, and boundaries. Every task will reference the plan revision it reviewed.</p><button className="text-button" disabled={!authoritative} onClick={() => { setPlanDraft(''); setDraftRevision(snapshot?.plan.revision ?? 0); setEditingPlan(true) }}>Write the first plan <Icon name="arrow" size={14} /></button></div></div>}
              <div className="panel-foot"><Icon name="check" size={14} /><span>Agents review this plan before proposing work.</span></div>
            </section>
            <section className="panel tasks-panel"><div className="panel-heading"><div><span className="section-mark">02</span><h2>Registered work</h2><span className="pill">{tasks.length}</span></div><span className="subtle-label">{stale ? 'Last received' : 'Coordinator state'}</span></div>{!tasks.length ? <Empty icon="branch" title="No work registered yet">An agent’s task description and declared scope will appear here after registration.</Empty> : <div className="task-list">{tasks.map((task) => <button key={task.id} className="task-row" onClick={() => setSelectedId(task.id)}><span className={`agent-avatar agent-${task.agent}`}>{agentNames[task.agent].slice(0, 1)}</span><div className="task-copy"><strong>{task.description}</strong><span>{agentNames[task.agent]}<i>·</i><code>{task.branch}</code><i>·</i>{task.scopes.length} scope{task.scopes.length !== 1 ? 's' : ''}</span></div><Status task={task} /><Icon name="arrow" size={15} /></button>)}</div>}</section>
          </div><div className="side-column">
            <section className="panel scope-panel"><div className="panel-heading"><div><Icon name="code" size={17} /><h2>Scope map</h2></div><button className="text-button" onClick={() => setView('worktree')}>View all</button></div><ScopeTree tasks={heldTasks} onSelect={(task) => setSelectedId(task.id)} /><div className="panel-foot">Parsed functions; unsupported or uncertain scopes reserve the whole file.</div></section>
            <section className="panel coordination-panel"><div className="panel-heading"><div><span className={`status-dot ${authoritative ? 'mint-dot' : ''}`} /><h2>Coordination</h2></div><span className="tiny-label">{runtime.mode.toUpperCase()}</span></div><div className="coordination-body"><div className="peer"><span className="peer-icon">M</span><div><strong>{snapshot?.nodeId ?? 'This Mac'}</strong><span>{snapshot?.leaderId === snapshot?.nodeId && snapshot ? 'Local coordinator' : 'Leadership not verified'}</span></div><span className={authoritative ? 'peer-status mint' : 'peer-status'}>{authoritative ? 'Ready' : 'Waiting'}</span></div><dl><div><dt>Committed log</dt><dd>{snapshot?.commitIndex ?? '—'}</dd></div><div><dt>Configured voters</dt><dd>{snapshot?.members.filter((member) => member.voter).length ?? '—'}</dd></div><div><dt>New approvals</dt><dd>{authoritative ? 'Available' : 'Paused'}</dd></div></dl><p className="field-hint">{runtime.mode === 'lan' ? 'LAN peers retain their reservations. New approvals require a majority of configured voters.' : 'Local development workspace. Open Workspace pool to connect Macs.'}</p></div></section>
          </div></div>
        </>}

        {view === 'worktree' && <RepositoryPanel key={runtime.workspaceKey} workspaceRepository={snapshot?.repository} bindingStale={stale} />}
        {view === 'pool' && <WorkspacePoolPanel onChanged={() => void refresh()} />}
        {view === 'agents' && <AgentSetupPanel key={runtime.workspaceKey} />}

        {view === 'worktree' && <div className="worktree-grid"><section className="panel branch-panel"><div className="panel-heading"><div><Icon name="branch" /><h2>Declared branches</h2></div><span className="tiny-label">REPORTED</span></div>{!branches.length ? <Empty icon="branch" title="Declared agent branches">Reported branch and base-commit relationships appear when an agent registers a task. Observe actual Git history above.</Empty> : <div className="branch-graph">{branches.map((branch) => <div className="branch-group" key={branch}><div className="branch-label"><span className="graph-node" /><Icon name="branch" size={15} /><strong>{branch}</strong></div>{tasks.filter((task) => task.branch === branch).map((task) => <button className="branch-task" key={task.id} onClick={() => setSelectedId(task.id)}><span className="graph-small-node" /><span><code>base {task.baseCommit.slice(0, 12)}</code><strong>{task.description}</strong><Status task={task} /></span></button>)}</div>)}</div>}<div className="panel-foot">Declared bases only. No observed Git commits or mergeability claims.</div></section><section className="panel"><div className="panel-heading"><div><Icon name="code" /><h2>Reserved files & functions</h2></div><span className="pill">{heldTasks.length} tasks</span></div><ScopeTree tasks={heldTasks} onSelect={(task) => setSelectedId(task.id)} /><div className="panel-foot">Reservations include active, blocked, and awaiting-merge tasks.</div></section></div>}

        {view === 'activity' && <section className="panel activity-panel"><div className="panel-heading"><div><Icon name="activity" /><h2>Workspace history</h2><span className="pill">{events.length}</span></div><span className="subtle-label">Commit order · latest first</span></div>{!events.length ? <Empty icon="activity" title="The story starts here">Shared-plan changes, task decisions, and conflict resolutions will be recorded here.</Empty> : <div className="event-list">{events.map((event) => <div className="event-row" key={event.index}><span className="event-marker" /><div><span className="event-type">{event.type.replaceAll('_', ' ')}</span><p>{event.message}</p>{event.taskId && <code>{event.taskId}</code>}</div><span className="event-index">#{event.index}</span></div>)}</div>}</section>}

        <footer className="page-footer"><span><span className="status-dot muted-dot" />{runtime.message}</span><span>Intent is shared. Code stays on your Mac.</span></footer>
      </div>
    </main>
    {selected && !proposal && <TaskDetail key={selected.id} task={selected} allTasks={tasks} busy={busy} authoritative={authoritative} actionError={actionError} onClose={() => setSelectedId(null)} onRevise={() => setProposal('revise')} onCommand={command} onObservePr={observePr} />}
    {proposal && <TaskForm key={proposal === 'revise' ? selected?.id : 'new'} task={proposal === 'revise' ? selected : undefined} planRevision={snapshot?.plan.revision ?? 0} busy={busy} authoritative={authoritative} actionError={actionError} onClose={() => { setProposal(null); setSelectedId(null) }} onSubmit={command} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
