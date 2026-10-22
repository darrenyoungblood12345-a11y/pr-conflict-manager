import React, { useEffect, useRef, useState } from 'react'
import type { WorkspacePoolView } from '../shared/lan.js'
import { createInvitationReview, type ReviewedInvitation } from './invitation-review.js'

const cleanError = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Workspace operation failed.'

export const WorkspacePoolPanel = ({ onChanged }: { onChanged(): void }) => {
  const api = window.workspace?.pool
  const [view, setView] = useState<WorkspacePoolView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('')
  const [invitation, setInvitation] = useState('')
  const [reviewed, setReviewed] = useState<ReviewedInvitation | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [retryConfirmed, setRetryConfirmed] = useState(false)
  const [retryPassword, setRetryPassword] = useState('')
  const [retryProfileId, setRetryProfileId] = useState<string | null>(null)
  const retryTargetRef = useRef<string | null>(null)
  const locked = useRef(false)
  const epoch = useRef(0)
  const refreshing = useRef(false)
  const viewRef = useRef<WorkspacePoolView | null>(null)
  const review = useRef(createInvitationReview())
  const applyView = (next: WorkspacePoolView) => {
    const previous = viewRef.current
    const targetId = retryTargetRef.current ?? next.current.id
    const priorInvitation = previous?.profiles.find(profile => profile.id === targetId)?.enrollment?.invitation
    const nextInvitation = next.profiles.find(profile => profile.id === targetId)?.enrollment?.invitation
    if (previous?.current.id !== next.current.id || next.current.id === targetId && next.lan?.stage === 'active' || JSON.stringify(priorInvitation) !== JSON.stringify(nextInvitation)) {
      setRetryConfirmed(false)
      setRetryPassword('')
    }
    if (previous && previous.current.id !== next.current.id) { retryTargetRef.current = null; setRetryProfileId(null) }
    viewRef.current = next
    setView(next)
  }
  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      if (!api || locked.current || refreshing.current) return
      refreshing.current = true
      const requestEpoch = epoch.current
      try {
        const next = await api.snapshot()
        if (mounted && !locked.current && requestEpoch === epoch.current) {
          applyView(next)
          setHost(current => current || next.interfaces[0]?.address || '')
        }
      } catch (error) { if (mounted && requestEpoch === epoch.current) setError(cleanError(error)) }
      finally { refreshing.current = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [api])

  const run = async (action: () => Promise<WorkspacePoolView>) => {
    if (locked.current) return
    locked.current = true
    epoch.current += 1
    setBusy(true)
    setError('')
    try { applyView(await action()); onChanged() } catch (error) { setError(cleanError(error)) }
    finally { setPassword(''); setRetryPassword(''); setBusy(false); locked.current = false }
  }
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!api) return
    if (mode === 'create') void run(() => api.create({ name, password, listenHost: host }))
    else if (review.current.matches(reviewed) && confirmed) {
      const reviewedText = reviewed.text
      void run(() => api.join({ name, password, listenHost: host, invitation: reviewedText, fingerprintConfirmed: true }))
    } else setError('Review the current invitation and compare its fingerprint before entering a password.')
  }
  const lan = view?.lan
  const active = lan?.members.filter(member => member.stage === 'active').length ?? 0
  const validReview = review.current.matches(reviewed)
  const pendingProfile = view?.profiles.find(profile => profile.id === (retryProfileId ?? view.current.id) && profile.enrollment)
  const retryTargetActive = pendingProfile?.id === view?.current.id && lan?.stage === 'active'
  const retry = () => {
    if (!api || !pendingProfile?.enrollment || !retryConfirmed || retryTargetActive) return
    const id = pendingProfile.id
    const fingerprint = pendingProfile.enrollment.invitation.fingerprint
    void run(async () => {
      const latest = viewRef.current
      const saved = latest?.profiles.find(profile => profile.id === id)
      if (!latest || latest.current.id === id && latest.lan?.stage === 'active' || saved?.enrollment?.invitation.fingerprint !== fingerprint
        || (retryTargetRef.current ?? latest.current.id) !== id) {
        throw new Error('The pending workspace changed. Review its saved invitation again.')
      }
      return api.retryJoin({ id, password: retryPassword, listenHost: host, fingerprintConfirmed: true })
    })
  }

  return <div className="pool-grid">
    <section className="panel"><div className="panel-heading"><h2>Workspace pool</h2><span className="tiny-label">{view?.current.mode === 'lan' ? 'LAN' : 'LOCAL'}</span></div>
      <div className="pool-body"><h3>{view?.current.name ?? 'Loading workspace…'}</h3>
        {view?.current.mode === 'local' ? <p className="field-hint">The development workspace runs on this Mac. Create a LAN workspace or open one you have previously joined.</p> : <>
          <div className="github-summary"><span>{lan?.stage ?? 'Connecting'}</span><span>{active} admitted Macs</span><span>{lan?.hasAuthority ? 'Quorum verified' : 'New work waiting for authority'}</span></div>
          <p className="field-hint">Admitted membership is not a live presence count. Reservations remain held when a Mac sleeps. A majority of configured voters must be connected for new approvals. Two joined voters need both Macs.</p>
          {lan?.joinError && <p className="form-error">{lan.joinError.message}</p>}
          <div className="pool-members">{lan?.members.map(member => <div key={member.deviceId}><code>{member.deviceId.slice(0, 12)}</code><span>{member.stage}</span><span>{member.deviceId === lan.leaderId ? 'Coordinator' : 'Participant'}</span></div>)}</div>
          {lan?.stage === 'active' && <label className="invitation-label">Invite another Mac<textarea readOnly className="mono invitation-text" value={JSON.stringify(lan.public, null, 2)} rows={7} /><span className="field-hint">Share this public invitation directly. On the joining Mac, compare this fingerprint before entering the workspace password.</span><code className="fingerprint">{lan.public.fingerprint}</code></label>}
        </>}
        {pendingProfile?.enrollment && !retryTargetActive && <div className="invitation-review"><strong>Retry pending enrollment: {pendingProfile.name}</strong><p className="field-hint">This reuses the saved device identity and enrollment request. Compare the original inviting Mac’s fingerprint again.</p><code className="fingerprint">{pendingProfile.enrollment.invitation.fingerprint}</code><p className="field-hint">{pendingProfile.enrollment.invitation.controlUrl}</p><label className="checkbox-label"><input type="checkbox" disabled={busy} checked={retryConfirmed} onChange={event => { setRetryConfirmed(event.target.checked); setRetryPassword('') }} />I compared the saved fingerprint directly and it matches.</label>{retryConfirmed && <label>Workspace password<input type="password" autoComplete="off" minLength={8} maxLength={1024} disabled={busy} value={retryPassword} onChange={event => setRetryPassword(event.target.value)} /></label>}<button className="button secondary" type="button" disabled={busy || !retryConfirmed || !retryPassword || !host} onClick={retry}>Retry saved enrollment</button></div>}
        {view?.error && <p className="form-error">{view.error}</p>}
        <p className="field-hint">LAN transport is under qualification. Multi-Mac sleep/wake, firewall behavior, and supported OS versions still require physical-device testing.</p>
      </div>
    </section>
    <section className="panel"><div className="panel-heading"><h2>{mode === 'create' ? 'Create a workspace' : 'Join a workspace'}</h2><button className="text-button" disabled={busy} onClick={() => { setMode(mode === 'create' ? 'join' : 'create'); review.current.replace(invitation); setReviewed(null); setConfirmed(false); setPassword(''); setError('') }}>{mode === 'create' ? 'Join instead →' : 'Create instead →'}</button></div>
      <form className="pool-body" onSubmit={submit}>
        <label>Workspace name<input disabled={busy} required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Your project" /></label>
        <label>This Mac’s LAN interface<select disabled={busy} value={host} onChange={event => setHost(event.target.value)} required>{view?.interfaces.map(entry => <option key={`${entry.name}:${entry.address}`} value={entry.address}>{entry.name} · {entry.address}</option>)}</select></label>
        {mode === 'join' && <>
          <label>Public invitation<textarea disabled={busy} className="mono" rows={5} value={invitation} maxLength={32768} onChange={event => { review.current.replace(event.target.value); setInvitation(event.target.value); setReviewed(null); setConfirmed(false); setPassword('') }} placeholder="Paste the invitation from a participating Mac" required /></label>
          <button className="button secondary" type="button" disabled={busy || reviewing || !api || !invitation} onClick={async () => {
            setReviewing(true)
            try { const result = await review.current.inspect(api!.inspectInvitation); if (result) { setReviewed(result); setConfirmed(false); setPassword(''); setError('') } } catch (error) { setError(cleanError(error)) }
            finally { setReviewing(false) }
          }}>{reviewing ? 'Reviewing…' : 'Review invitation'}</button>
          {validReview && <div className="invitation-review"><strong>Compare this fingerprint with the inviting Mac</strong><code className="fingerprint">{reviewed.peer.fingerprint}</code><p className="field-hint">{reviewed.peer.controlUrl} · workspace {reviewed.peer.workspaceId}</p><label className="checkbox-label"><input disabled={busy} type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setPassword('') }} />I compared the fingerprint directly and it matches.</label></div>}
        </>}
        {(mode === 'create' || validReview && confirmed) && <label>Shared workspace password<input disabled={busy} type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /><span className="field-hint">Every joined Mac has equal access. Private identity keys and the password verifier are protected by macOS Keychain; the password is never saved.</span></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary" type="submit" disabled={!api || busy || mode === 'join' && (!validReview || !confirmed)}>{busy ? 'Connecting…' : mode === 'create' ? 'Create & open workspace' : 'Join workspace'}</button>
      </form>
    </section>
    <section className="panel saved-workspaces"><div className="panel-heading"><h2>Saved on this Mac</h2><span className="pill">{view?.profiles.length ?? 0}</span></div><div className="pool-body">{view?.profiles.map(profile => <div className="saved-workspace" key={profile.id}><div><strong>{profile.name}</strong><code>{profile.workspaceId.slice(0, 12)}</code></div><button className="button secondary" disabled={busy || !host || view.current.id === profile.id && (!profile.enrollment || lan?.stage === 'active')} onClick={() => {
      if (profile.enrollment) { retryTargetRef.current = profile.id; setRetryProfileId(profile.id); setRetryConfirmed(false); setRetryPassword('') }
      else if (api) void run(() => api.open({ id: profile.id, listenHost: host }))
    }}>{profile.enrollment ? 'Review pending enrollment' : view.current.id === profile.id ? 'Open' : 'Open workspace'}</button></div>)}{!view?.profiles.length && <p className="field-hint">Joined workspaces and their local replicated history will appear here.</p>}</div></section>
  </div>
}
