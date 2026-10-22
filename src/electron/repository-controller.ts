import { inspectRepository, observeGitHubRepository, observeGitHubPullRequest } from '../repository/index.js'
import type { RepositoryView } from '../shared/repository.js'
import type { RepositoryIdentity } from '../shared/contracts.js'
import { repositoryIdentitySchema } from '../integrations/schemas.js'

import { githubIdentity } from '../shared/github-identity.js'
export { githubIdentity } from '../shared/github-identity.js'

interface RepositoryControllerDependencies {
  inspect: typeof inspectRepository
  observe: typeof observeGitHubRepository
  observePullRequest?: typeof observeGitHubPullRequest
}

export const createRepositoryController = (dependencies: RepositoryControllerDependencies = {
  inspect: inspectRepository,
  observe: observeGitHubRepository,
}) => {
  let view: RepositoryView = { local: null, github: null, hasSessionToken: false }
  let token: string | undefined
  let generation = 0
  let selectionRequest = 0
  let localRequest = 0
  let remoteInFlight: Promise<RepositoryView> | undefined
  const snapshot = () => structuredClone(view)

  const select = async (root: string) => {
    const request = ++selectionRequest
    generation += 1
    remoteInFlight = undefined
    const local = await dependencies.inspect(root)
    if (request !== selectionRequest) return snapshot()
    generation += 1
    token = undefined
    remoteInFlight = undefined
    view = { local, github: null, hasSessionToken: false }
    return snapshot()
  }

  const refreshLocal = async () => {
    const root = view.local?.root
    const currentGeneration = generation
    const request = ++localRequest
    if (!root) return snapshot()
    try {
      const local = await dependencies.inspect(root)
      if (generation === currentGeneration && request === localRequest) {
        const previousIdentity = githubIdentity(view.local?.origin)
        const nextIdentity = githubIdentity(local.origin)
        const changedRepository = JSON.stringify(previousIdentity)?.toLowerCase() !== JSON.stringify(nextIdentity)?.toLowerCase()
        if (changedRepository) {
          generation += 1
          token = undefined
          remoteInFlight = undefined
          view = { local, github: null, hasSessionToken: false }
        } else {
          view = { ...view, local, localError: undefined }
        }
      }
    } catch {
      if (generation === currentGeneration && request === localRequest) view = { ...view, localError: 'The selected repository could not be read. This is the last observed local state.' }
    }
    return snapshot()
  }

  const refreshGitHub = (): Promise<RepositoryView> => {
    if (remoteInFlight) return remoteInFlight
    const identity = githubIdentity(view.local?.origin)
    if (!identity) return Promise.reject(new Error('Select a repository with a github.com origin to observe GitHub.'))
    const currentGeneration = generation
    const pending = dependencies.observe({ ...identity, token, previous: view.github ?? undefined }).then(github => {
      if (generation === currentGeneration) view = { ...view, github }
      return snapshot()
    }).finally(() => { if (remoteInFlight === pending) remoteInFlight = undefined })
    remoteInFlight = pending
    return pending
  }

  const observeLinkedPullRequest = async (expectedIdentity: RepositoryIdentity, number: number) => {
    const expected = repositoryIdentitySchema.safeParse(expectedIdentity)
    if (!expected.success || !Number.isSafeInteger(number) || number < 1) throw new Error('A valid bound repository and pull-request number are required.')
    const root = view.local?.root
    const currentGeneration = generation
    if (!root) throw new Error('Choose this workspace’s local clone before verifying a linked pull request.')
    const assertCurrent = () => {
      if (generation !== currentGeneration || view.local?.root !== root) {
        throw new Error('The selected clone or credentials changed during pull-request observation. Refresh before retrying.')
      }
    }
    const inspectOrigin = async () => {
      assertCurrent()
      const local = await dependencies.inspect(root)
      assertCurrent()
      const actual = githubIdentity(local.origin)
      if (actual?.owner !== expected.data.owner || actual?.repo !== expected.data.repo) {
        throw new Error('The selected clone does not match this workspace’s linked GitHub repository.')
      }
    }
    await inspectOrigin()
    assertCurrent()
    const observation = await (dependencies.observePullRequest ?? observeGitHubPullRequest)({ ...expected.data, number, token })
    assertCurrent()
    // Origin configuration can change outside this application while HTTP is in
    // flight. A second actual Git read prevents using that proof for another clone.
    await inspectOrigin()
    if (observation.number !== number || observation.requestedRepository.owner !== expected.data.owner
      || observation.requestedRepository.repo !== expected.data.repo) throw new Error('The linked pull-request observation did not match its requested repository and number.')
    return observation
  }

  const setSessionToken = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096 || (value !== '' && !/^[\x21-\x7E]+$/.test(value))) {
      throw new Error('Use a GitHub token without whitespace, up to 4096 characters.')
    }
    // Tokens never enter repository snapshots, settings, IPC replies, or the shared log.
    generation += 1
    token = value || undefined
    remoteInFlight = undefined
    view = { ...view, github: null, hasSessionToken: Boolean(token) }
    return snapshot()
  }

  const reset = () => {
    selectionRequest += 1
    localRequest += 1
    generation += 1
    token = undefined
    remoteInFlight = undefined
    view = { local: null, github: null, hasSessionToken: false }
  }
  return { snapshot, select, refreshLocal, refreshGitHub, observeLinkedPullRequest, setSessionToken, reset }
}
