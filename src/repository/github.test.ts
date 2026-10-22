import { describe, expect, it } from 'vitest'
import { observeGitHubRepository, observeGitHubPullRequest } from './github.js'

const head = 'a'.repeat(40)
const privateToken = 'github_pat_private_local_only'
const repository = { full_name: 'acme/project', html_url: 'https://github.com/acme/project', private: true, default_branch: 'main' }
const branch = { name: 'main', commit: { sha: 'b'.repeat(40) }, protected: true }
const pull = {
  number: 7, title: 'Coordinate safely', html_url: 'https://github.com/acme/project/pull/7',
  state: 'open', draft: false, merged_at: null, updated_at: '2026-10-20T20:00:00Z',
  head: { ref: 'feat/scopes', sha: head }, base: { ref: 'main' }, user: { login: 'contributor' },
}

interface Request { url: URL; init: RequestInit }
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', ...headers },
})

const mockApi = (override?: (request: Request) => Response | undefined) => {
  const requests: Request[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = { url: new URL(input instanceof Request ? input.url : input.toString()), init: init ?? {} }
    requests.push(request)
    const alternative = override?.(request)
    if (alternative) return alternative
    switch (request.url.pathname) {
      case '/repos/acme/project': return response(repository)
      case '/repos/acme/project/branches': return response([branch])
      case '/repos/acme/project/pulls': return response([pull])
      case `/repos/acme/project/commits/${head}/check-runs`: return response({ total_count: 1, check_runs: [{ id: 42, name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/project/actions/runs/42' }] })
      case `/repos/acme/project/commits/${head}/status`: return response({ state: 'success', total_count: 1, statuses: [{ context: 'external-ci', state: 'success', description: 'Passed', target_url: 'https://ci.example.test/build/7' }] })
      default: throw new Error(`Unexpected fixture request ${request.url.pathname}`)
    }
  }
  return { fetchImpl, requests }
}

describe('read-only GitHub observation', () => {
  it('observes real API-shaped PR/branch/check records with GET-only fixed-origin requests and no token in results', async () => {
    const { fetchImpl, requests } = mockApi()
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project', token: privateToken }, fetchImpl)
    expect(snapshot.status).toBe('fresh')
    expect(snapshot.stale).toBe(false)
    expect(snapshot.branches[0]).toMatchObject({ name: 'main', protected: true })
    expect(snapshot.pullRequests[0]).toMatchObject({ number: 7, headSha: head, mergeability: 'unknown' })
    expect(snapshot.checks[0]).toMatchObject({ sha: head, status: 'fresh', combinedState: 'success', errors: [] })
    expect(requests).toHaveLength(5)
    requests.forEach(({ url, init }) => {
      expect(url.origin).toBe('https://api.github.com')
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.body).toBeUndefined()
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${privateToken}`)
    })
    expect(JSON.stringify(snapshot)).not.toContain(privateToken)
  })

  it('omits authorization for public reads and does not report zero checks as a passing combined status', async () => {
    const { fetchImpl, requests } = mockApi(({ url }) => url.pathname.endsWith('/status')
      ? response({ state: 'pending', total_count: 0, statuses: [] }) : undefined)
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project' }, fetchImpl)
    expect(requests.every(({ init }) => !new Headers(init.headers).has('authorization'))).toBe(true)
    expect(snapshot.checks[0].combinedState).toBe('unknown')
  })

  it('retains explicitly stale same-repository observations under rate limits and redacts server/error bodies', async () => {
    const previous = await observeGitHubRepository({ owner: 'acme', repo: 'project' }, mockApi().fetchImpl)
    const fetchImpl: typeof fetch = async () => response({ message: `Never echo ${privateToken}` }, 403, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000', 'retry-after': '60',
    })
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project', token: privateToken, previous }, fetchImpl)
    expect(snapshot.status).toBe('rate-limited')
    expect(snapshot.stale).toBe(true)
    expect(snapshot.lastSuccessfulAt).toBe(previous.lastSuccessfulAt)
    expect(snapshot.pullRequests).toEqual(previous.pullRequests)
    expect(snapshot.rateLimit).toMatchObject({ remaining: 0, retryAfterSeconds: 60, resetAt: new Date(1800000000000).toISOString() })
    expect(JSON.stringify(snapshot)).not.toContain(privateToken)
    const other = await observeGitHubRepository({ owner: 'other', repo: 'project', previous }, fetchImpl)
    expect(other.stale).toBe(false)
    expect(other.pullRequests).toEqual([])
  })

  it('reports missing check permissions as partial unknown data while retaining successful commit statuses', async () => {
    const { fetchImpl } = mockApi(({ url }) => url.pathname.endsWith('/check-runs') ? response({ message: privateToken }, 403) : undefined)
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project', token: privateToken }, fetchImpl)
    expect(snapshot.status).toBe('fresh')
    expect(snapshot.checks[0]).toMatchObject({ status: 'partial', checkRuns: [], combinedState: 'success', errors: [expect.objectContaining({ code: 'forbidden' })] })
    expect(snapshot.pullRequests[0].mergeability).toBe('unknown')
    expect(JSON.stringify(snapshot)).not.toContain(privateToken)
  })

  it('rejects malformed repository selection and ignores arbitrary pagination origins', async () => {
    const { fetchImpl, requests } = mockApi(({ url }) => url.pathname.endsWith('/branches') ? response([branch], 200, {
      link: '<https://attacker.invalid/capture>; rel="next"',
    }) : undefined)
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project' }, fetchImpl)
    expect(snapshot.coverage.branchesTruncated).toBe(true)
    expect(requests.filter(({ url }) => url.pathname.endsWith('/branches'))).toHaveLength(2)
    expect(requests.every(({ url }) => url.origin === 'https://api.github.com')).toBe(true)
    await expect(observeGitHubRepository({ owner: '../capture', repo: 'project' }, fetchImpl)).rejects.toThrow('one GitHub.com repository')
  })

  it('treats redirects, unavailable credentials, malformed data and network exceptions as unknown without leaking authentication', async () => {
    for (const status of [301, 401, 404]) {
      const fetchImpl: typeof fetch = async () => response({ message: privateToken }, status)
      const result = await observeGitHubRepository({ owner: 'acme', repo: 'project', token: privateToken }, fetchImpl)
      expect(result.status).toBe('unavailable')
      expect(result.error?.httpStatus).toBe(status)
      expect(result.repository).toBeNull()
      expect(JSON.stringify(result)).not.toContain(privateToken)
    }
    const malformed = await observeGitHubRepository({ owner: 'acme', repo: 'project' }, async () => response({ private: false }))
    expect(malformed.error?.code).toBe('invalid-response')
    const failed = await observeGitHubRepository({ owner: 'acme', repo: 'project', token: privateToken }, async () => { throw new Error(privateToken) })
    expect(failed.error?.code).toBe('unavailable')
    expect(JSON.stringify(failed)).not.toContain(privateToken)
  })

  it('stops check polling when GitHub rate limits a head instead of issuing more requests', async () => {
    const { fetchImpl, requests } = mockApi(({ url }) => url.pathname.endsWith('/check-runs')
      ? response({}, 429, { 'x-ratelimit-remaining': '0', 'retry-after': '30' }) : undefined)
    const snapshot = await observeGitHubRepository({ owner: 'acme', repo: 'project' }, fetchImpl)
    expect(snapshot.checks[0]).toMatchObject({ status: 'unavailable', combinedState: 'unknown', errors: [expect.objectContaining({ code: 'rate-limited' })] })
    expect(requests.some(({ url }) => url.pathname.endsWith('/status'))).toBe(false)
  })
})

const exactPull = {
  ...pull, state: 'closed', merged: true, merged_at: '2026-10-20T21:00:00Z', merge_commit_sha: 'c'.repeat(40),
  base: { ...pull.base, repo: { full_name: 'acme/project' } },
}

describe('exact read-only linked pull-request observation', () => {
  it('verifies complete merge evidence using only the exact numbered GET and keeps credentials private', async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(input.toString()), init: init ?? {} })
      return response(exactPull)
    }
    const result = await observeGitHubPullRequest({ owner: 'Acme', repo: 'Project', number: 7, token: privateToken }, fetchImpl)
    expect(result).toMatchObject({ status: 'fresh', mergeVerified: true, number: 7, requestedRepository: { owner: 'acme', repo: 'project' }, pullRequest: { number: 7, state: 'closed', url: 'https://github.com/acme/project/pull/7' } })
    expect(requests).toHaveLength(1)
    expect(requests[0].url.toString()).toBe('https://api.github.com/repos/acme/project/pulls/7')
    expect(requests[0].init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(requests[0].init.body).toBeUndefined()
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe(`Bearer ${privateToken}`)
    expect(JSON.stringify(result)).not.toContain(privateToken)
  })

  it('rejects a different PR number/base repository or noncanonical HTML identity instead of accepting a list-like match', async () => {
    const replacements = [
      { number: 8 }, { number: '7' }, { base: { ...exactPull.base, repo: { full_name: 'other/project' } } },
      ...[
        'https://github.com/acme/project/pull/8', 'https://github.com/acme/project/pull/7?secret=value',
        'https://github.com/acme/project/pull/7#discussion', 'https://github.com:443/acme/project/pull/7',
        'https://user@github.com/acme/project/pull/7', 'https://github.com.evil.invalid/acme/project/pull/7',
        'https://github.com/acme/other/../project/pull/7', 'https://github.com/acme/project/pull/07',
        'https://github.com/acme/project/PULL/7',
      ].map(html_url => ({ html_url })),
    ]
    for (const replacement of replacements) {
      const result = await observeGitHubPullRequest({ owner: 'acme', repo: 'project', number: 7 }, async () => response({ ...exactPull, ...replacement }))
      expect(result).toMatchObject({ status: 'unavailable', mergeVerified: false, error: { code: 'invalid-response' } })
      expect(result.pullRequest).toBeUndefined()
    }
  })

  it('does not verify closed-unmerged PRs, missing merge evidence, or malformed timestamps/hashes', async () => {
    for (const replacement of [{ merged: false }, { state: 'open' }, { merged_at: null }, { merge_commit_sha: null }]) {
      const result = await observeGitHubPullRequest({ owner: 'acme', repo: 'project', number: 7 }, async () => response({ ...exactPull, ...replacement }))
      expect(result.status).toBe('fresh')
      expect(result.mergeVerified).toBe(false)
    }
    for (const replacement of [
      { merged: 'true' }, { merged_at: 'not-a-timestamp' }, { merged_at: '2026-02-30T10:00:00Z' },
      { merged_at: '2026-10-20T25:00:00Z' }, { merge_commit_sha: 'not-a-git-hash' }, { merge_commit_sha: 'a'.repeat(41) },
    ]) {
      const result = await observeGitHubPullRequest({ owner: 'acme', repo: 'project', number: 7 }, async () => response({ ...exactPull, ...replacement }))
      expect(result).toMatchObject({ status: 'unavailable', mergeVerified: false, error: { code: 'invalid-response' } })
    }
  })

  it('makes no request for invalid numbers and reports authorization/rate/network failures without retaining merge success or secrets', async () => {
    let count = 0
    const fetchImpl: typeof fetch = async () => { count += 1; return response(exactPull) }
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(observeGitHubPullRequest({ owner: 'acme', repo: 'project', number }, fetchImpl)).rejects.toThrow('positive safe')
    }
    expect(count).toBe(0)
    for (const status of [301, 401, 403, 404, 429]) {
      const result = await observeGitHubPullRequest({ owner: 'acme', repo: 'project', number: 7, token: privateToken }, async () => response({ message: privateToken }, status, status === 429 ? { 'retry-after': '45', 'x-ratelimit-remaining': '0' } : {}))
      expect(result.mergeVerified).toBe(false)
      expect(result.pullRequest).toBeUndefined()
      expect(result.status).toBe(status === 429 ? 'rate-limited' : 'unavailable')
      expect(JSON.stringify(result)).not.toContain(privateToken)
    }
    const failed = await observeGitHubPullRequest({ owner: 'acme', repo: 'project', number: 7 }, async () => { throw new Error(privateToken) })
    expect(failed).toMatchObject({ status: 'unavailable', mergeVerified: false })
    expect(JSON.stringify(failed)).not.toContain(privateToken)
  })
})
