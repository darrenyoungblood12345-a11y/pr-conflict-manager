export interface DirtyFile {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unmerged' | 'type-changed'
}

export interface GitBranch {
  name: string
  ref: string
  head: string
  current: boolean
  remote: boolean
  symbolicTarget?: string
}

export interface GitCommit {
  hash: string
  parentHashes: string[]
  subject: string
  timestamp: string
}

export interface RepositorySnapshot {
  root: string
  origin?: string
  branch: string | null
  head: string | null
  dirtyFiles: DirtyFile[]
  branches: GitBranch[]
  commits: GitCommit[]
  observedAt: string
  limits: { commitLimit: number; commitsAtLimit: boolean }
}

export interface GitHubRepository {
  owner: string
  repo: string
  fullName: string
  url: string
  private: boolean
  defaultBranch: string
}

export interface GitHubBranch {
  name: string
  head: string
  protected: boolean
}

export interface GitHubPullRequest {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  mergedAt: string | null
  updatedAt: string
  headRef: string
  headSha: string
  baseRef: string
  author: string | null
  // The list API cannot determine mergeability; never infer it from passing checks.
  mergeability: 'unknown'
}

export interface GitHubCheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  url: string | null
}

export interface GitHubStatusContext {
  name: string
  state: string
  description: string | null
  url: string | null
}

export interface ObservationFailure {
  code: 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'unavailable' | 'invalid-response'
  message: string
  httpStatus?: number
}

export interface GitHubCommitChecks {
  sha: string
  status: 'fresh' | 'partial' | 'unavailable'
  observedAt: string
  checkRuns: GitHubCheckRun[]
  contexts: GitHubStatusContext[]
  combinedState: string | 'unknown'
  truncated: boolean
  errors: ObservationFailure[]
}

export interface RateLimit {
  remaining: number | null
  limit: number | null
  resetAt: string | null
  retryAfterSeconds: number | null
}

export interface GitHubSnapshot {
  repository: GitHubRepository | null
  requestedRepository: { owner: string; repo: string }
  observedAt: string
  lastSuccessfulAt: string | null
  status: 'fresh' | 'unavailable' | 'rate-limited'
  stale: boolean
  error?: ObservationFailure
  rateLimit: RateLimit
  branches: GitHubBranch[]
  pullRequests: GitHubPullRequest[]
  checks: GitHubCommitChecks[]
  coverage: {
    branchesTruncated: boolean
    pullRequestsTruncated: boolean
    checkHeadsObserved: number
    checkHeadsAvailable: number
    checkHeadsLimit: number
  }
}

export interface GitHubObservationOptions {
  owner: string
  repo: string
  token?: string
  previous?: GitHubSnapshot
}

export interface GitHubPullRequestObservationOptions {
  owner: string
  repo: string
  number: number
  token?: string
}

export interface GitHubPullRequestObservation {
  requestedRepository: { owner: string; repo: string }
  number: number
  observedAt: string
  status: 'fresh' | 'unavailable' | 'rate-limited'
  mergeVerified: boolean
  pullRequest?: GitHubPullRequest
  error?: ObservationFailure
  rateLimit: RateLimit
}
