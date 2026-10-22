import type {
  GitHubBranch, GitHubCheckRun, GitHubCommitChecks, GitHubObservationOptions,
  GitHubPullRequest, GitHubRepository, GitHubSnapshot, GitHubStatusContext,
  ObservationFailure, RateLimit,
  GitHubPullRequestObservation, GitHubPullRequestObservationOptions,
} from './types.js'

const API_ORIGIN = 'https://api.github.com'
const PAGE_SIZE = 100
const PAGE_LIMIT = 2
const CHECK_HEAD_LIMIT = 10
const REQUEST_TIMEOUT_MS = 8000
const OBSERVATION_TIMEOUT_MS = 30000
const RESPONSE_LIMIT = 4 * 1024 * 1024
const emptyRateLimit = (): RateLimit => ({ remaining: null, limit: null, resetAt: null, retryAfterSeconds: null })

class ObservationError extends Error {
  constructor(readonly failure: ObservationFailure, readonly rateLimit: RateLimit) {
    super(failure.message)
  }
}

const invalidResponse = () => new ObservationError({
  code: 'invalid-response', message: 'GitHub returned an unsupported response. This observation is unknown.',
}, emptyRateLimit())

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum = 4096): string => {
  if (typeof value !== 'string' || value.length > maximum) throw invalidResponse()
  return value
}
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidResponse()
  return Number(value)
}
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw invalidResponse()
  return value
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 1000) throw invalidResponse()
  return value
}
const nullableText = (value: unknown) => value === null ? null : text(value)
const sha = (value: unknown) => {
  const result = text(value, 64)
  if (!/^[a-f0-9]{40,64}$/i.test(result)) throw invalidResponse()
  return result
}
const webUrl = (value: unknown, githubOnly = false): string | null => {
  if (value === null || value === undefined) return null
  const result = new URL(text(value))
  if (result.protocol !== 'https:' || result.username || result.password || (githubOnly && result.hostname !== 'github.com')) return null
  return result.toString()
}

const numberHeader = (headers: Headers, name: string) => {
  const value = headers.get(name)
  if (value === null || !/^\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) ? result : null
}
const readRateLimit = (headers: Headers): RateLimit => {
  const reset = numberHeader(headers, 'x-ratelimit-reset')
  return {
    remaining: numberHeader(headers, 'x-ratelimit-remaining'), limit: numberHeader(headers, 'x-ratelimit-limit'),
    resetAt: reset === null || reset > 8640000000000 ? null : new Date(reset * 1000).toISOString(),
    retryAfterSeconds: numberHeader(headers, 'retry-after'),
  }
}

const httpFailure = (status: number, rateLimit: RateLimit): ObservationError => {
  if (status === 429 || (status === 403 && (rateLimit.remaining === 0 || rateLimit.retryAfterSeconds !== null))) {
    return new ObservationError({ code: 'rate-limited', message: 'GitHub rate limited observation. Current remote state is unknown.', httpStatus: status }, rateLimit)
  }
  const descriptions: Record<number, [ObservationFailure['code'], string]> = {
    401: ['unauthorized', 'GitHub credentials are missing, expired, or invalid.'],
    403: ['forbidden', 'GitHub did not permit this read. Verify repository access and read permissions.'],
    404: ['not-found', 'The repository or resource is unavailable or not accessible to these credentials.'],
  }
  const [code, message] = descriptions[status] ?? ['unavailable', 'GitHub observation is unavailable. Current remote state is unknown.']
  return new ObservationError({ code, message, httpStatus: status }, rateLimit)
}

const readJson = async (response: Response): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT) throw invalidResponse()
  if (!response.body) throw invalidResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > RESPONSE_LIMIT) throw invalidResponse()
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof ObservationError) throw error
    throw invalidResponse()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface ApiResponse { data: unknown; headers: Headers }
type ReadApi = (resource: string, query?: Record<string, string>) => Promise<ApiResponse>

const createReadApi = (owner: string, repo: string, token: string | undefined, fetchImpl: typeof fetch) => {
  let rateLimit = emptyRateLimit()
  const observationSignal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS)
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const get: ReadApi = async (resource, query = {}) => {
    const url = new URL(`${base}${resource}`, API_ORIGIN)
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))
    if (url.origin !== API_ORIGIN) throw invalidResponse()
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.any([observationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'Agent-PR-Monitor', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      rateLimit = readRateLimit(response.headers)
      if (!response.ok) throw httpFailure(response.status, rateLimit)
      return { data: await readJson(response), headers: response.headers }
    } catch (error) {
      if (error instanceof ObservationError) throw error
      // Never include fetch errors, response bodies, URLs, headers, or tokens.
      throw new ObservationError({ code: 'unavailable', message: 'GitHub could not be reached. Current remote state is unknown.' }, rateLimit)
    }
  }
  return { get, rateLimit: () => rateLimit }
}

const listPages = async (get: ReadApi, resource: string, query: Record<string, string> = {}) => {
  const entries: unknown[] = []
  let truncated = false
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const result = await get(resource, { ...query, per_page: String(PAGE_SIZE), page: String(page) })
    const items = array(result.data)
    if (items.length > PAGE_SIZE) throw invalidResponse()
    entries.push(...items)
    const hasNext = /;\s*rel="next"/.test(result.headers.get('link') ?? '')
    if (!hasNext) break
    // Do not follow server-supplied Link URLs; construct the next fixed-origin page.
    truncated = page === PAGE_LIMIT
  }
  return { entries, truncated }
}

const parseRepository = (value: unknown, owner: string, repo: string): GitHubRepository => {
  const data = record(value)
  const fullName = text(data.full_name)
  if (fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw invalidResponse()
  const url = webUrl(data.html_url, true)
  if (!url) throw invalidResponse()
  return { owner, repo, fullName, url, private: boolean(data.private), defaultBranch: text(data.default_branch) }
}

const parseBranch = (value: unknown): GitHubBranch => {
  const data = record(value)
  return { name: text(data.name), head: sha(record(data.commit).sha), protected: boolean(data.protected) }
}

const parsePullRequest = (value: unknown): GitHubPullRequest => {
  const data = record(value)
  const head = record(data.head)
  const base = record(data.base)
  if (data.state !== 'open' && data.state !== 'closed') throw invalidResponse()
  const url = webUrl(data.html_url, true)
  if (!url) throw invalidResponse()
  return {
    number: integer(data.number), title: text(data.title), url, state: data.state,
    draft: boolean(data.draft), mergedAt: nullableText(data.merged_at), updatedAt: text(data.updated_at),
    headRef: text(head.ref), headSha: sha(head.sha), baseRef: text(base.ref),
    author: data.user === null ? null : text(record(data.user).login), mergeability: 'unknown',
  }
}

const parseCheckRun = (value: unknown): GitHubCheckRun => {
  const data = record(value)
  return {
    id: integer(data.id), name: text(data.name), status: text(data.status),
    conclusion: nullableText(data.conclusion), url: webUrl(data.html_url),
  }
}

const parseStatus = (value: unknown): GitHubStatusContext => {
  const data = record(value)
  return { name: text(data.context), state: text(data.state), description: nullableText(data.description), url: webUrl(data.target_url) }
}

const observeChecks = async (get: ReadApi, head: string): Promise<GitHubCommitChecks> => {
  const errors: ObservationFailure[] = []
  let checkRuns: GitHubCheckRun[] = []
  let contexts: GitHubStatusContext[] = []
  let combinedState = 'unknown'
  let truncated = false
  let successes = 0
  // Serial reads let rate-limit state remain deterministic and avoid request bursts.
  try {
    const result = await get(`/commits/${encodeURIComponent(head)}/check-runs`, { per_page: String(PAGE_SIZE), filter: 'latest' })
    const data = record(result.data)
    checkRuns = array(data.check_runs).map(parseCheckRun)
    if (checkRuns.length > PAGE_SIZE) throw invalidResponse()
    truncated = integer(data.total_count) > checkRuns.length || /;\s*rel="next"/.test(result.headers.get('link') ?? '')
    successes += 1
  } catch (error) {
    errors.push(error instanceof ObservationError ? error.failure : invalidResponse().failure)
  }
  if (!errors.some((error) => error.code === 'rate-limited')) {
    try {
      const result = await get(`/commits/${encodeURIComponent(head)}/status`, { per_page: String(PAGE_SIZE) })
      const data = record(result.data)
      contexts = array(data.statuses).map(parseStatus)
      if (contexts.length > PAGE_SIZE) throw invalidResponse()
      combinedState = contexts.length ? text(data.state) : 'unknown'
      truncated ||= integer(data.total_count) > contexts.length || /;\s*rel="next"/.test(result.headers.get('link') ?? '')
      successes += 1
    } catch (error) {
      errors.push(error instanceof ObservationError ? error.failure : invalidResponse().failure)
    }
  }
  return {
    sha: head, status: successes === 2 ? 'fresh' : successes === 1 ? 'partial' : 'unavailable',
    observedAt: new Date().toISOString(), checkRuns, contexts, combinedState, truncated, errors,
  }
}

const sameRepository = (snapshot: GitHubSnapshot | undefined, owner: string, repo: string) =>
  snapshot?.requestedRepository.owner.toLowerCase() === owner.toLowerCase() &&
  snapshot.requestedRepository.repo.toLowerCase() === repo.toLowerCase()

const validateRepositoryOptions = (owner: string, repo: string, token?: string) => {
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner) || !/^[a-z\d_.-]{1,100}$/i.test(repo) || ['.', '..'].includes(repo)) {
    throw new Error('Select one GitHub.com repository using an owner and repository name.')
  }
  if (token !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('The local GitHub credential has an invalid format.')
}

const validMergeTimestamp = (value: string) => {
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!fields) return false
  const [year, month, day, hour, minute, second] = fields.slice(1, 7).map(Number)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59
    && (!fields[7] || Number(fields[8]) <= 23 && Number(fields[9]) <= 59) && Number.isFinite(Date.parse(value))
}

/** Exact PR evidence is read independently; cached list observations cannot release scope. */
export const observeGitHubPullRequest = async (
  options: GitHubPullRequestObservationOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubPullRequestObservation> => {
  validateRepositoryOptions(options.owner, options.repo, options.token)
  if (!Number.isSafeInteger(options.number) || options.number < 1) throw new Error('Use a positive safe pull-request number.')
  const owner = options.owner.toLowerCase()
  const repo = options.repo.toLowerCase()
  const number = options.number
  const requestedRepository = { owner, repo }
  const observedAt = new Date().toISOString()
  const api = createReadApi(owner, repo, options.token, fetchImpl)
  try {
    const data = record((await api.get(`/pulls/${encodeURIComponent(String(number))}`)).data)
    if (data.number !== number || text(record(record(data.base).repo).full_name).toLowerCase() !== `${owner}/${repo}`) throw invalidResponse()
    const canonicalUrl = `https://github.com/${owner}/${repo}/pull/${number}`
    // Case is insignificant for GitHub owner/repository identity. Every other
    // byte must be canonical: no credentials, encoded paths, ports, or suffixes.
    const htmlIdentity = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(text(data.html_url))
    if (!htmlIdentity || htmlIdentity[1].toLowerCase() !== owner || htmlIdentity[2].toLowerCase() !== repo
      || htmlIdentity[3] !== String(number)) throw invalidResponse()
    const pullRequest = { ...parsePullRequest(data), url: canonicalUrl }
    const merged = boolean(data.merged)
    if (pullRequest.mergedAt !== null && !validMergeTimestamp(pullRequest.mergedAt)) throw invalidResponse()
    const mergeCommit = data.merge_commit_sha === null ? null : sha(data.merge_commit_sha)
    if (mergeCommit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(mergeCommit)) throw invalidResponse()
    const mergeVerified = merged && pullRequest.state === 'closed' && pullRequest.mergedAt !== null
      && mergeCommit !== null && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(mergeCommit)
    return { requestedRepository, number, observedAt, status: 'fresh', mergeVerified, pullRequest, rateLimit: api.rateLimit() }
  } catch (error) {
    const failure = error instanceof ObservationError ? error : invalidResponse()
    return {
      requestedRepository, number, observedAt, status: failure.failure.code === 'rate-limited' ? 'rate-limited' : 'unavailable',
      mergeVerified: false, error: failure.failure, rateLimit: failure.failure.code === 'invalid-response' ? api.rateLimit() : failure.rateLimit,
    }
  }
}

export const observeGitHubRepository = async (
  options: GitHubObservationOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubSnapshot> => {
  const { owner, repo, token } = options
  validateRepositoryOptions(owner, repo, token)
  const api = createReadApi(owner, repo, token, fetchImpl)
  const observedAt = new Date().toISOString()
  try {
    const repository = parseRepository((await api.get('')).data, owner, repo)
    const branchPages = await listPages(api.get, '/branches')
    const pullPages = await listPages(api.get, '/pulls', { state: 'all', sort: 'updated', direction: 'desc' })
    const branches = branchPages.entries.map(parseBranch)
    const pullRequests = pullPages.entries.map(parsePullRequest)
    const heads = [...new Set(pullRequests.filter((pr) => pr.state === 'open').map((pr) => pr.headSha))]
    const checks: GitHubCommitChecks[] = []
    for (const head of heads.slice(0, CHECK_HEAD_LIMIT)) {
      checks.push(await observeChecks(api.get, head))
      if (api.rateLimit().remaining === 0 || checks.at(-1)?.errors.some((error) => error.code === 'rate-limited')) break
    }
    return {
      repository, requestedRepository: { owner, repo }, observedAt, lastSuccessfulAt: observedAt,
      status: 'fresh', stale: false, rateLimit: api.rateLimit(), branches, pullRequests, checks,
      coverage: {
        branchesTruncated: branchPages.truncated, pullRequestsTruncated: pullPages.truncated,
        checkHeadsObserved: checks.length, checkHeadsAvailable: heads.length, checkHeadsLimit: CHECK_HEAD_LIMIT,
      },
    }
  } catch (error) {
    const failure = error instanceof ObservationError ? error : invalidResponse()
    const previous = sameRepository(options.previous, owner, repo) ? options.previous : undefined
    return {
      repository: previous?.repository ?? null, requestedRepository: { owner, repo }, observedAt,
      lastSuccessfulAt: previous?.lastSuccessfulAt ?? null,
      status: failure.failure.code === 'rate-limited' ? 'rate-limited' : 'unavailable', stale: Boolean(previous?.lastSuccessfulAt),
      error: failure.failure, rateLimit: failure.rateLimit, branches: previous?.branches ?? [],
      pullRequests: previous?.pullRequests ?? [], checks: previous?.checks ?? [],
      coverage: previous?.coverage ?? {
        branchesTruncated: false, pullRequestsTruncated: false,
        checkHeadsObserved: 0, checkHeadsAvailable: 0, checkHeadsLimit: CHECK_HEAD_LIMIT,
      },
    }
  }
}
