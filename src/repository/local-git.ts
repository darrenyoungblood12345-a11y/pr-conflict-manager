import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DirtyFile, GitBranch, GitCommit, RepositorySnapshot } from './types.js'

const COMMIT_LIMIT = 100
const OUTPUT_LIMIT = 8 * 1024 * 1024
const TIMEOUT_MS = 10000

export class RepositoryObservationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryObservationError'
  }
}

const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
})

const runGit = (root: string, args: string[], allowedExitCodes: number[] = []): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', [
      '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.quotePath=false', '-C', root, ...args,
    ], { env: gitEnvironment(), encoding: 'utf8', maxBuffer: OUTPUT_LIMIT, timeout: TIMEOUT_MS }, (error, stdout) => {
      if (!error) return resolve(stdout)
      if (typeof error.code === 'number' && allowedExitCodes.includes(error.code)) return resolve('')
      // Git stderr can contain private remote URLs or credentials. Do not surface it.
      reject(new RepositoryObservationError('Git inspection failed or exceeded its local observation limit.'))
    })
  })

const removeTerminalNewline = (value: string) => value.endsWith('\n') ? value.slice(0, -1) : value

const dirtyKind = (index: string, worktree: string): DirtyFile['kind'] => {
  const pair = `${index}${worktree}`
  if (pair === '??') return 'untracked'
  if (pair.includes('U') || ['AA', 'DD'].includes(pair)) return 'unmerged'
  if (pair.includes('R')) return 'renamed'
  if (pair.includes('C')) return 'copied'
  if (pair.includes('D')) return 'deleted'
  if (pair.includes('A')) return 'added'
  if (pair.includes('T')) return 'type-changed'
  return 'modified'
}

const parseDirtyFiles = (output: string): DirtyFile[] => {
  const records = output.split('\0')
  const files: DirtyFile[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') throw new RepositoryObservationError('Git returned an invalid path observation.')
    const indexStatus = record[0]
    const worktreeStatus = record[1]
    const file: DirtyFile = { path: record.slice(3), indexStatus, worktreeStatus, kind: dirtyKind(indexStatus, worktreeStatus) }
    if (`${indexStatus}${worktreeStatus}`.includes('R') || `${indexStatus}${worktreeStatus}`.includes('C')) {
      const source = records[++index]
      if (!source) throw new RepositoryObservationError('Git returned an incomplete rename observation.')
      file.originalPath = source
    }
    files.push(file)
  }
  return files
}

const parseBranches = (output: string): GitBranch[] => output.split('\n').filter(Boolean).map((line) => {
  const [ref, head, current, symbolicTarget] = line.split('\0')
  const remote = ref.startsWith('refs/remotes/')
  return {
    name: ref.replace(/^refs\/(heads|remotes)\//, ''), ref, head, current: current === '*', remote,
    ...(symbolicTarget ? { symbolicTarget } : {}),
  }
})

const parseCommits = (output: string): GitCommit[] => {
  const fields = output.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 4 !== 0) throw new RepositoryObservationError('Git returned an invalid commit observation.')
  return Array.from({ length: fields.length / 4 }, (_, index) => ({
    hash: fields[index * 4], parentHashes: fields[index * 4 + 1].split(' ').filter(Boolean),
    subject: fields[index * 4 + 2], timestamp: fields[index * 4 + 3],
  }))
}

const safeOrigin = (value: string) => {
  const origin = removeTerminalNewline(value)
  if (!origin) return undefined
  // Check SCP syntax first: a colon in a credential could look like a URL scheme.
  if (!origin.includes('://') && /^[^/@]+@[^/:]+:/.test(origin)) {
    return origin.replace(/^[^/@]+@(?=[^/:]+:)/, 'git@')
  }
  try {
    const url = new URL(origin)
    if (!url.hostname && url.protocol !== 'file:') return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    // SCP-style SSH remotes have a username but no URL parser representation.
    return origin.replace(/^[^/@]+@(?=[^/:]+:)/, 'git@')
  }
}

export const inspectRepository = async (selectedRoot: string): Promise<RepositorySnapshot> => {
  if (!selectedRoot || !path.isAbsolute(selectedRoot)) throw new RepositoryObservationError('Select an absolute repository root.')
  const root = await realpath(selectedRoot).catch(() => { throw new RepositoryObservationError('The selected repository cannot be opened.') })
  if (!(await stat(root)).isDirectory()) throw new RepositoryObservationError('Select a repository directory.')
  const observedRoot = removeTerminalNewline(await runGit(root, ['rev-parse', '--show-toplevel']))
  const canonicalTopLevel = await realpath(observedRoot)
  if (canonicalTopLevel !== root) throw new RepositoryObservationError('Select the repository or worktree root itself, rather than a subfolder.')

  const results = await Promise.allSettled([
    runGit(root, ['config', '--get', 'remote.origin.url'], [1]),
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]),
    runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], [1]),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=none']),
    runGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)', 'refs/heads', 'refs/remotes']),
  ])
  const values = results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  const [originOutput, branchOutput, headOutput, statusOutput, branchesOutput] = values
  const head = removeTerminalNewline(headOutput) || null
  const commitsOutput = head || branchesOutput
    ? await runGit(root, ['log', '--all', ...(head ? ['HEAD'] : []), '--topo-order', '--no-show-signature', '-z', '--format=%H%x00%P%x00%s%x00%cI', `--max-count=${COMMIT_LIMIT}`])
    : ''
  const commits = parseCommits(commitsOutput)
  return {
    root, origin: safeOrigin(originOutput), branch: removeTerminalNewline(branchOutput) || null,
    head, dirtyFiles: parseDirtyFiles(statusOutput),
    branches: parseBranches(branchesOutput), commits, observedAt: new Date().toISOString(),
    limits: { commitLimit: COMMIT_LIMIT, commitsAtLimit: commits.length === COMMIT_LIMIT },
  }
}
