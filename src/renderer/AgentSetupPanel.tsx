import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../shared/contracts.js'
import type { AgentSetupEnvironment, PreparedAgentSetup } from '../shared/agent-setup.js'
import './agent-setup.css'

const agentNames: Record<AgentKind, string> = { codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', 'claude-code': 'Claude Code' }
const sessionFields: Record<AgentKind, string> = { codex: 'session_id', cursor: 'conversation_id', opencode: 'sessionID', 'claude-code': 'session_id' }
const errorMessage = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Agent setup could not be prepared.'

export const AgentSetupPanel = () => {
  const api = window.workspace?.agents
  const [environment, setEnvironment] = useState<AgentSetupEnvironment | null>(null)
  const [agent, setAgent] = useState<AgentKind>('codex')
  const [ownerId, setOwnerId] = useState('local-user')
  const [sessionId, setSessionId] = useState('')
  const [prepared, setPrepared] = useState<PreparedAgentSetup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const running = useRef(false)

  const refresh = useCallback(async () => {
    if (!api || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    setPrepared(null)
    setCopied('')
    try { setEnvironment(await api.inspect()) } catch (error) { setError(errorMessage(error)) }
    finally { running.current = false; setBusy(false) }
  }, [api])
  useEffect(() => { void refresh() }, [refresh])

  const prepare = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!api || running.current || !environment?.repositoryRoot || !environment.endpointFile) return
    running.current = true
    setBusy(true)
    setError('')
    setPrepared(null)
    setCopied('')
    try {
      setPrepared(await api.prepare({
        agent, ownerId: ownerId.trim(), sessionId: sessionId.trim(),
        expectedRepositoryRoot: environment.repositoryRoot, expectedEndpointFile: environment.endpointFile,
      }))
    } catch (error) { setError(errorMessage(error)) }
    finally { running.current = false; setBusy(false) }
  }

  const copy = async (label: string, contents: string) => {
    try {
      await navigator.clipboard.writeText(contents)
      setCopied(label)
    } catch { setError('Clipboard access is unavailable. Select and copy the snippet text.') }
  }

  const selectedInstallation = environment?.agents.find(installation => installation.agent === agent)
  const generatesSession = agent === 'claude-code'
  return <section className="agent-setup">
    <div className="agent-setup-heading"><div><span className="eyebrow">YOUR TOOLS. ONE SHARED PLAN.</span><h2>Connect an existing agent session.</h2><p>Prepare reviewable project snippets. Your agent continues in its own terminal or app.</p></div><button className="button secondary" disabled={!api || busy} onClick={() => void refresh()}>{busy ? 'Checking…' : 'Refresh setup status'}</button></div>
    {!api && <p className="form-error">Open the desktop app to prepare local agent setup.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="agent-installations">{(Object.keys(agentNames) as AgentKind[]).map(kind => {
      const installation = environment?.agents.find(item => item.agent === kind)
      return <button key={kind} disabled={busy} aria-pressed={agent === kind} className={`agent-installation ${agent === kind ? 'chosen' : ''}`} onClick={() => { setAgent(kind); setPrepared(null); setCopied('') }}>
        <strong>{agentNames[kind]}</strong><span>{installation?.version ? `CLI ${installation.version}` : installation?.installation === 'not-found' ? 'CLI not found' : installation ? 'CLI version unknown' : 'Checking installation'}</span><small>{installation?.qualification === 'version-blocked' ? 'Update required' : 'Client behavior unverified'}</small>
      </button>
    })}</div>
    <div className="agent-setup-grid"><section className="panel"><div className="panel-heading"><h2>Session connection</h2><span className="tiny-label">LOCAL & PRIVATE</span></div><form className="agent-session-form" onSubmit={event => void prepare(event)}>
      <label>Selected clone<input readOnly value={environment?.repositoryRoot ?? 'Choose a clone in Worktree'} /></label>
      <label>Owner identifier<input disabled={busy} value={ownerId} onChange={event => { setOwnerId(event.target.value); setPrepared(null) }} maxLength={128} required autoComplete="off" /></label>
      <label>{generatesSession ? 'Claude Code session ID (optional)' : `Actual ${agentNames[agent]} session ID`} <code>{sessionFields[agent]}</code><input disabled={busy} value={sessionId} onChange={event => { setSessionId(event.target.value); setPrepared(null) }} placeholder={generatesSession ? 'Leave blank to generate one for a new session' : `Paste the existing session’s ${sessionFields[agent]}`} maxLength={128} required={!generatesSession} autoComplete="off" /></label>
      <p className="field-hint">{generatesSession
        ? 'Leave blank and the app generates a session ID plus the command that starts Claude Code with it. Paste an existing session_id to resume that session instead.'
        : 'Use the identifier from the running client session. The app does not invent or capture it.'} Owner/session IDs allow letters, numbers, _, ., :, and -.</p>
      {!environment?.ready && <p className="field-hint">{environment?.reason ?? 'Checking the selected clone and integration bridge…'}</p>}
      <button className="button primary" disabled={busy || !environment?.ready || !ownerId.trim() || (!sessionId.trim() && !generatesSession)} type="submit">Prepare private session & snippets</button>
      <p className="field-hint">Creates a unique private context and launcher in this app’s storage. Client configuration files remain yours to review and merge.</p>
    </form></section>
    <section className="panel"><div className="panel-heading"><h2>What is verified</h2><span className="tiny-label">{selectedInstallation?.qualification === 'version-blocked' ? 'VERSION BLOCKED' : 'NOT QUALIFIED'}</span></div><div className="agent-qualification"><p>{selectedInstallation?.summary ?? 'Installation detection is in progress.'}</p>{selectedInstallation?.limitations.map(limitation => <p className="field-hint" key={limitation}>{limitation}</p>)}<p className="field-hint">Adapter tests and protocol tests do not prove a particular client will honor a pause. An already-running command may finish.</p></div></section></div>
    {prepared && <section className="panel agent-snippets"><div className="panel-heading"><h2>Review and merge these snippets</h2><span className="tiny-label">{agentNames[prepared.agent]}</span></div><div className="agent-snippet-body">
      <p className="field-hint">No project or global agent settings were changed. Preserve existing servers, hooks, rules, and instructions when merging these fragments.</p>
      <dl className="agent-private-paths"><div><dt>Session context</dt><dd><code>{prepared.contextFile}</code></dd></div><div><dt>Workspace connection</dt><dd><code>{prepared.endpointFile}</code></dd></div><div><dt>Private launcher</dt><dd><code>{prepared.launcherFile}</code></dd></div></dl>
      {prepared.files.map(file => <div className="agent-snippet" key={file.path}><div><code>{file.path}</code><button className="text-button" onClick={() => void copy(file.path, file.contents)}>{copied === file.path ? 'Copied' : 'Copy snippet'}</button></div><textarea readOnly aria-label={`Snippet for ${file.path}`} value={file.contents} rows={Math.min(14, Math.max(4, file.contents.split('\n').length))} spellCheck={false} /></div>)}
      {prepared.launchCommand && <div className="agent-snippet"><div><strong>Then start Claude Code in this clone</strong><button className="text-button" onClick={() => void copy('launch', prepared.launchCommand ?? '')}>{copied === 'launch' ? 'Copied' : 'Copy command'}</button></div><textarea readOnly aria-label="Claude Code launch command" value={prepared.launchCommand} rows={2} spellCheck={false} /><p className="field-hint">Merge the snippets first: Claude Code loads hooks and MCP servers when the session starts. Session ID <code>{prepared.sessionId}</code>.</p></div>}
      <div className="agent-snippet"><div><strong>Project instructions</strong><button className="text-button" onClick={() => void copy('instructions', prepared.instructions)}>{copied === 'instructions' ? 'Copied' : 'Copy instructions'}</button></div><textarea readOnly aria-label="Project coordination instructions" value={prepared.instructions} rows={6} /></div>
      <div className="agent-notices">{prepared.notices.map(notice => <p className="field-hint" key={notice}>{notice}</p>)}</div>
      <p className="field-hint">After merging and trusting the configuration, ask the agent to read the shared plan, list active tasks, and propose its intended work. Verify a denied native edit in that actual client before relying on enforcement.</p>
    </div></section>}
  </section>
}
