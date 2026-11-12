import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceClient, validateEndpoint, WorkspaceConnectionError } from './client.js'

const token = 'a'.repeat(64)

afterEach(() => vi.unstubAllGlobals())

describe('local coordinator client', () => {
  it('rejects network hosts and URL credentials before sending the local token', () => {
    expect(() => validateEndpoint({ url: 'http://192.168.1.2:1234', token })).toThrow()
    expect(() => validateEndpoint({ url: 'http://user:pass@127.0.0.1:1234', token })).toThrow()
    expect(() => validateEndpoint({ url: 'http://localhost.evil.test:1234', token })).toThrow()
  })

  it('rejects short tokens and endpoint path injection', () => {
    expect(() => validateEndpoint({ url: 'http://127.0.0.1:1234', token: 'abc' })).toThrow()
    expect(() => validateEndpoint({ url: 'http://127.0.0.1:1234/path', token })).toThrow()
  })

  it('sends a unique request ID with each command and refuses redirects', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWorkspaceClient({ url: 'http://127.0.0.1:1234', token })
    await api.command({ type: 'set_plan', expectedRevision: 0, markdown: 'Plan' })
    await api.command({ type: 'set_plan', expectedRevision: 1, markdown: 'Next' })
    const options = fetchMock.mock.calls.map(call => call[1])
    expect(options[0].redirect).toBe('manual')
    expect(JSON.parse(options[0].body).requestId).not.toBe(JSON.parse(options[1].body).requestId)
    expect(options[0].headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('redacts endpoint secrets from transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`failed token ${token}`)))
    const api = createWorkspaceClient({ url: 'http://127.0.0.1:1234', token })
    await expect(api.snapshot()).rejects.toThrow('coordinator is unavailable')
    await expect(api.snapshot()).rejects.not.toThrow(token)
  })

  it('reuses a pending request ID after an uncertain response instead of duplicating a mutation', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Connection lost after commit'))
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWorkspaceClient({ url: 'http://127.0.0.1:1234', token })
    const command = { type: 'set_plan', expectedRevision: 0, markdown: 'Plan' } as const
    await expect(api.command(command)).rejects.toThrow('coordinator is unavailable')
    await api.command({ markdown: 'Plan', type: 'set_plan', expectedRevision: 0 })
    const ids = fetchMock.mock.calls.map(call => JSON.parse(call[1].body).requestId)
    expect(ids[0]).toBe(ids[1])
  })

  it('distinguishes unavailable transport from malformed responses, redirects and authentication refusal', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network gone'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://untrusted.test' } }))
      .mockResolvedValueOnce(new Response('{malformed'))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWorkspaceClient({ url: 'http://127.0.0.1:1234', token })
    for (const expected of [true, true, false, false, false]) {
      const error = await api.snapshot().catch(value => value)
      expect(error).toBeInstanceOf(WorkspaceConnectionError)
      expect(error.offlineEligible).toBe(expected)
    }
  })

  it('follows a republished endpoint on the next request and keeps the pending request ID of an uncertain mutation', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Connection lost after commit'))
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    const published = { current: { url: 'http://127.0.0.1:1234', token } as { url: string; token: string } | undefined }
    const api = createWorkspaceClient(published.current, async () => published.current)
    const command = { type: 'set_plan', expectedRevision: 0, markdown: 'Plan' } as const
    await expect(api.command(command)).rejects.toThrow('coordinator is unavailable')
    published.current = undefined
    const closed = await api.command(command).catch(value => value)
    expect(closed).toMatchObject({ message: 'The local app is closed', retryable: true, offlineEligible: true })
    published.current = { url: 'http://127.0.0.1:5678', token: 'b'.repeat(64) }
    await api.command(command)
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(['http://127.0.0.1:1234/v1/commands', 'http://127.0.0.1:5678/v1/commands'])
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${'b'.repeat(64)}`)
    const ids = fetchMock.mock.calls.map(call => JSON.parse(call[1].body).requestId)
    expect(ids[0]).toBe(ids[1])
  })

  it('retries once on the endpoint republished during a failed request, and not at all when it is unchanged', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.port === '1234') throw new Error('connection refused')
      return new Response(JSON.stringify({ commitIndex: 3 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = { url: 'http://127.0.0.1:1234', token }
    const second = { url: 'http://127.0.0.1:5678', token: 'b'.repeat(64) }
    const republished = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
    await expect(createWorkspaceClient(first, republished).snapshot()).resolves.toEqual({ commitIndex: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockClear()
    await expect(createWorkspaceClient(first, async () => first).snapshot()).rejects.toThrow('coordinator is unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed without sending anything when the republished endpoint is unreadable or unsafe', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const unreadable = await createWorkspaceClient({ url: 'http://127.0.0.1:1234', token }, async () => { throw new SyntaxError('Invalid JSON') }).snapshot().catch(value => value)
    expect(unreadable).toBeInstanceOf(SyntaxError)
    const unsafe = await createWorkspaceClient({ url: 'http://127.0.0.1:1234', token }, async () => ({ url: 'http://192.168.1.2:1234', token })).snapshot().catch(value => value)
    expect(unsafe).toMatchObject({ retryable: false, offlineEligible: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests a receipt for the exact escaped task and revision without a mutation', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWorkspaceClient({ url: 'http://127.0.0.1:1234', token })
    await api.taskReceipt?.('task:a', 4)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:1234/v1/task-receipt?taskId=task%3Aa&revision=4')
  })
})
