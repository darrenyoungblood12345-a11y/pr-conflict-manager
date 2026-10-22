import { inspectRepository } from '../repository/local-git.js'
import { repositoryIdentitySchema } from '../integrations/schemas.js'
import type { RepositoryIdentity, WorkspaceApi } from '../shared/contracts.js'
import { githubIdentity } from '../shared/github-identity.js'

interface RepositoryBindingOptions {
  api: WorkspaceApi
  root: string
  assertCurrent(): void
}

const matches = (left: RepositoryIdentity, right: RepositoryIdentity) => left.owner === right.owner && left.repo === right.repo

/** Bind only an observed GitHub origin, never a renderer-supplied URL or identity. */
export const ensureWorkspaceRepository = async (
  { api, root, assertCurrent }: RepositoryBindingOptions,
  inspect: typeof inspectRepository = inspectRepository,
): Promise<RepositoryIdentity> => {
  assertCurrent()
  const local = await inspect(root)
  assertCurrent()
  const actual = repositoryIdentitySchema.safeParse(githubIdentity(local.origin))
  if (!actual.success) throw new Error('Choose a clone with a supported github.com origin before registering work.')
  const snapshot = await api.snapshot()
  assertCurrent()
  if (snapshot.hasAuthority !== true) throw new Error('Fresh workspace authority is required to verify its repository before work.')

  if (snapshot.repository) {
    const bound = repositoryIdentitySchema.safeParse(snapshot.repository)
    if (!bound.success || !matches(bound.data, actual.data)) throw new Error('The selected clone does not match this workspace’s bound GitHub repository.')
    return actual.data
  }

  const result = await api.command({ type: 'bind_repository', repository: actual.data })
  assertCurrent()
  if (!result.ok) throw new Error('The workspace could not bind this GitHub repository. Refresh and review the current binding.')
  // A historical command acceptance cannot prove the current binding/authority.
  const current = await api.snapshot()
  assertCurrent()
  const bound = repositoryIdentitySchema.safeParse(current.repository)
  if (current.hasAuthority !== true || !bound.success || !matches(bound.data, actual.data)) {
    throw new Error('The workspace repository binding could not be confirmed with fresh authority.')
  }
  return actual.data
}
