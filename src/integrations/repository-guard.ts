import { inspectRepository } from '../repository/local-git.js'
import type { RepositoryIdentity, Snapshot, WorkspaceApi } from '../shared/contracts.js'
import { githubIdentity } from '../shared/github-identity.js'

export const validateRepositoryBinding = async (root: string, expected?: RepositoryIdentity) => {
  if (!expected) return
  const local = await inspectRepository(root)
  const actual = githubIdentity(local.origin)
  if (!actual || actual.owner !== expected.owner || actual.repo !== expected.repo) {
    throw new Error('Selected clone does not match this workspace GitHub repository')
  }
}

export const ensureRepositoryBinding = async (api: WorkspaceApi, root: string, snapshot: Snapshot, required: boolean) => {
  if (snapshot.repository) return validateRepositoryBinding(root, snapshot.repository)
  if (!required) return
  if (snapshot.hasAuthority !== true) throw new Error('Fresh authority is required to bind a repository')
  const actual = githubIdentity((await inspectRepository(root)).origin)
  if (!actual) throw new Error('Select a clone with a supported github.com origin')
  const result = await api.command({ type: 'bind_repository', repository: actual })
  if (!result.ok) throw new Error('Workspace repository binding was refused')
  const current = await api.snapshot()
  if (current.hasAuthority !== true || current.repository?.owner !== actual.owner || current.repository?.repo !== actual.repo) {
    throw new Error('Workspace repository binding could not be confirmed')
  }
}
