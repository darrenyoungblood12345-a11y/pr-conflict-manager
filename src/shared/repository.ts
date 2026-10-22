import type { GitHubPullRequestObservation, GitHubSnapshot, RepositorySnapshot } from '../repository/types.js'

export interface RepositoryView {
  local: RepositorySnapshot | null
  github: GitHubSnapshot | null
  localError?: string
  hasSessionToken: boolean
}

export interface RepositoryApi {
  snapshot(): Promise<RepositoryView>
  choose(): Promise<RepositoryView>
  refreshLocal(): Promise<RepositoryView>
  refreshGitHub(): Promise<RepositoryView>
  setSessionToken(token: string): Promise<RepositoryView>
  observeTaskPullRequest(taskId: string, expectedRevision: number, workspaceKey: string): Promise<GitHubPullRequestObservation>
}
