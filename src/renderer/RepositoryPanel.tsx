import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { RepositoryView } from '../shared/repository.js'
import { layoutCommits } from './commit-graph.js'
import type { RepositoryIdentity } from '../shared/contracts.js'

const empty: RepositoryView = { local: null, github: null, hasSessionToken: false }

export const RepositoryPanel = ({ workspaceRepository, bindingStale = false }: { workspaceRepository?: RepositoryIdentity; bindingStale?: boolean }) => {
  const [view, setView] = useState<RepositoryView>(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const request = useRef(0)
  const running = useRef(false)
  const api = window.workspace?.repository
  useEffect(() => {
    const initialRequest = request.current
    let active = true
    void api?.snapshot().then(snapshot => {
      if (active && request.current === initialRequest) setView(snapshot)
    }).catch(() => undefined)
    return () => { active = false }
  }, [api])
  useEffect(() => { setToken('') }, [view.local?.root])

  const run = async (work: () => Promise<RepositoryView>) => {
    if (running.current) return
    running.current = true
    request.current += 1
    setBusy(true)
    setError('')
    try { setView(await work()) } catch (error) {
      setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Repository observation failed.')
    } finally { running.current = false; setBusy(false) }
  }
  const local = view.local
  const github = view.github
  const graph = layoutCommits(local?.commits ?? [])
  const graphWidth = 24 + graph.laneCount * 16
  const branchesByHead = useMemo(() => {
    const grouped = new Map<string, { names: string[]; count: number }>()
    local?.branches.forEach(branch => {
      const group = grouped.get(branch.head) ?? { names: [], count: 0 }
      group.count += 1
      if (group.names.length < 5) group.names.push(branch.name)
      grouped.set(branch.head, group)
    })
    return grouped
  }, [local])

  return <section className="repository-observation">
    <div className="panel-foot" style={{ border: '1px solid var(--line)', borderRadius: 5 }}><span>Workspace repository: <strong>{workspaceRepository ? `${workspaceRepository.owner}/${workspaceRepository.repo}` : 'Not bound yet'}</strong>. {workspaceRepository ? bindingStale ? 'Saved binding; coordination is unavailable.' : 'Tasks must use a clone of this repository.' : 'The first registered task binds this workspace to its selected GitHub origin.'}</span></div>
    <div className="repository-toolbar"><div><span className="eyebrow">THIS MAC’S CLONE</span><h2>{local?.branch ?? (local ? 'Detached HEAD' : 'Connect a repository')}</h2><p>{local?.root ?? 'Choose your Git clone to see observed branches, commits, and changed files.'}</p></div><div className="heading-actions"><button className="button secondary" disabled={!api || busy} onClick={() => api && void run(api.choose)}>{local ? 'Change clone' : 'Choose clone'}</button>{local && <button className="button secondary" disabled={busy} onClick={() => api && void run(api.refreshLocal)}>Refresh Git</button>}</div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {view.localError && <p className="form-error" role="status">{view.localError}</p>}
    {local && <>
      <div className="worktree-grid">
        <section className="panel"><div className="panel-heading"><h2>Observed commit graph</h2><span className="tiny-label">LOCAL GIT</span></div>
          {!graph.nodes.length ? <p className="repository-empty">This clone has no observed commits.</p> : <div className="commit-graph" style={{ gridTemplateColumns: `${graphWidth}px minmax(0, 1fr)` }}>
            <svg width={graphWidth} height={graph.nodes.length * 52} aria-label="Git commit ancestry" role="img">
              {graph.edges.map((edge, index) => <path key={index} d={`M${12 + edge.from.lane * 16},${edge.from.row * 52 + 26} L${12 + (edge.to?.lane ?? edge.from.lane) * 16},${edge.to ? edge.to.row * 52 + 26 : edge.from.row * 52 + 49}`} stroke="currentColor" fill="none" opacity=".45" strokeDasharray={edge.to ? undefined : '2 3'} />)}
              {graph.nodes.map(node => <circle key={node.commit.hash} cx={12 + node.lane * 16} cy={node.row * 52 + 26} r="4" fill="#b6c7a3" />)}
            </svg>
            <div>{graph.nodes.map(({ commit }) => <div className="commit-row" key={commit.hash}><strong title={commit.subject}>{commit.subject || '(no subject)'}</strong><span><code>{commit.hash.slice(0, 10)}</code>{(branchesByHead.get(commit.hash)?.names ?? []).map(name => <span className="branch-tag" key={name}>{name}</span>)}{(branchesByHead.get(commit.hash)?.count ?? 0) > 5 && <span className="branch-tag">+{branchesByHead.get(commit.hash)!.count - 5} refs</span>}</span></div>)}</div>
          </div>}
          <div className="panel-foot">{local.limits.commitsAtLimit ? `Showing up to ${local.limits.commitLimit} commits. Dashed edges continue outside this view.` : 'Edges follow actual Git parent hashes.'} {graph.edgesOmitted > 0 ? `${graph.edgesOmitted} additional ancestry edges omitted for display. ` : ''}No fetch is performed.</div>
        </section>
        <section className="panel"><div className="panel-heading"><h2>Working copy</h2><span className="pill">{local.dirtyFiles.length}</span></div>{local.dirtyFiles.length ? <div className="repository-files">{local.dirtyFiles.slice(0, 200).map(file => <div key={file.path}><code>{file.indexStatus}{file.worktreeStatus}</code><span style={{ whiteSpace: 'pre-wrap' }}>{file.originalPath ? `${file.originalPath} → ` : ''}{file.path}</span></div>)}</div> : <p className="repository-empty">No local changes observed.</p>}<div className="panel-foot">{local.dirtyFiles.length > 200 ? `Showing 200 of ${local.dirtyFiles.length} paths. ` : ''}Observed {new Date(local.observedAt).toLocaleTimeString()}. Changed files do not imply an accepted reservation.</div></section>
      </div>
      <section className="panel github-panel"><div className="panel-heading"><h2>GitHub observation</h2><button className="text-button" disabled={busy} onClick={() => api && void run(api.refreshGitHub)}>Refresh GitHub →</button></div>
        <div className="github-access"><label>Optional read-only GitHub token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder={view.hasSessionToken ? 'Token set for this session' : 'Needed for private repositories'} maxLength={4096} /></label><button className="button secondary" disabled={busy || !api} onClick={() => { if (api) void run(async () => { const result = await api.setSessionToken(token); setToken(''); return result }) }}>{token ? 'Use for this session' : 'Clear token'}</button><p className="field-hint">Held in memory until the app quits or you switch clones. Sent only to api.github.com. Repository contents, pull requests, checks, and commit statuses need read access.</p></div>
        {!github ? <p className="repository-empty">Refresh to observe the selected clone’s github.com origin. Remote data is never treated as edit permission.</p> : <>
          <div className="github-summary"><strong>{github.repository?.fullName ?? `${github.requestedRepository.owner}/${github.requestedRepository.repo}`}</strong><span>{github.stale ? 'Saved observation · ' : ''}{github.status}</span><span>{github.branches.length} branches</span><span>{github.stale ? 'Refresh attempted' : 'Observed'} {new Date(github.observedAt).toLocaleTimeString()}</span>{github.stale && github.lastSuccessfulAt && <span>Data last refreshed {new Date(github.lastSuccessfulAt).toLocaleString()}</span>}</div>
          {github.error && <p className="form-error">{github.error.message}</p>}
          <div className="pr-list">{github.pullRequests.slice(0, 200).map(pr => { const checks = github.checks.find(check => check.sha === pr.headSha); return <div className="pr-row" key={pr.number}><div><strong>#{pr.number} {pr.title}</strong><span>{pr.headRef} → {pr.baseRef}</span></div><span>{pr.mergedAt ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open'}</span><div>{checks ? <details><summary>{checks.checkRuns.length} check runs · {checks.contexts.length} statuses · {checks.status}</summary><p className="field-hint">Commit status: {checks.combinedState}. This does not certify merge readiness.</p>{checks.checkRuns.slice(0, 6).map(check => <p className="field-hint" key={check.id}>{check.name}: {check.conclusion ?? check.status}</p>)}{checks.contexts.slice(0, 6).map(context => <p className="field-hint" key={context.name}>{context.name}: {context.state}</p>)}{checks.checkRuns.length > 6 || checks.contexts.length > 6 || checks.truncated ? <p className="field-hint">Additional check results are omitted or outside the observed page.</p> : null}{checks.errors.map((failure, index) => <p className="form-error" key={index}>{failure.message}</p>)}</details> : <span>Checks not observed</span>}</div><span>Mergeability unknown</span></div> })}</div>
          {!github.pullRequests.length && <p className="repository-empty">{github.status === 'fresh' ? 'No pull requests in the observed pages.' : 'Pull requests unavailable.'}</p>}
          <div className="panel-foot">{github.coverage.branchesTruncated || github.coverage.pullRequestsTruncated ? 'Results are truncated. ' : ''}Checks cover {github.coverage.checkHeadsObserved} of {github.coverage.checkHeadsAvailable} open PR heads (limit {github.coverage.checkHeadsLimit}). {github.rateLimit.remaining !== null ? `${github.rateLimit.remaining} API requests remaining.` : ''} Observation cannot merge or release a task.</div>
        </>}
      </section>
    </>}
  </section>
}
