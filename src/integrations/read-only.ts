import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AgentContext } from './schemas.js'
import type { ToolInvocation } from './gate.js'
import { checkedSourcePath, isWithin } from './source-path.js'

const boundedString = z.string().min(1).max(4096)
const count = z.number().int().nonnegative().max(1000000)
const readSchema = z.object({
  file_path: boundedString.optional(), filePath: boundedString.optional(), path: boundedString.optional(),
  offset: count.optional(), limit: count.optional(), pages: z.string().regex(/^[0-9,-]+$/).max(100).optional(),
}).strict()
const globSchema = z.object({ pattern: boundedString, path: boundedString.optional() }).strict()
const grepSchema = z.object({
  pattern: boundedString, path: boundedString.optional(), glob: boundedString.optional(), include: boundedString.optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(), type: boundedString.optional(),
  '-B': count.optional(), '-A': count.optional(), '-C': count.optional(), '-n': z.boolean().optional(), '-i': z.boolean().optional(),
  head_limit: count.optional(), offset: count.optional(), multiline: z.boolean().optional(),
}).strict()

const safeGlob = (value: string) => !value.startsWith('/') && !value.startsWith('~')
  && !/[\\:{}()!\p{Cc}]/u.test(value) && value.split('/').every(part => part !== '' && !part.includes('..')
    && !/^\.+$/.test(part.replace(/[*?\[\]^-]/g, '')))

/** Audit every potential search target rather than assuming a client's ignore/symlink defaults. */
const checkedSearchTree = async (root: string, start: string) => {
  const queue = [{ absolute: start, depth: 0 }]
  const visited: { count: number } = { count: 0 }
  while (queue.length) {
    const current = queue.shift()!
    if (++visited.count > 4096 || current.depth > 64) throw new Error('Search tree exceeds the qualified planning limit')
    await checkedSourcePath(root, root, current.absolute, true)
    const stat = await lstat(current.absolute)
    if (stat.isDirectory()) {
      const directory = await opendir(current.absolute)
      for await (const entry of directory) {
        if (queue.length + visited.count >= 4096) throw new Error('Search tree exceeds the qualified planning limit')
        queue.push({ absolute: path.join(current.absolute, entry.name), depth: current.depth + 1 })
      }
    }
  }
}

export const isNativeReadTool = (name: string) => ['Read', 'read', 'Glob', 'glob', 'Grep', 'grep'].includes(name)

export const validateNativeRead = async (context: AgentContext, invocation: ToolInvocation) => {
  const root = await realpath(context.repositoryRoot)
  const cwd = await realpath(invocation.cwd)
  if (cwd !== root && !isWithin(root, cwd)) throw new Error('Working directory is outside the selected clone')
  if (['Read', 'read'].includes(invocation.name)) {
    const input = readSchema.parse(invocation.input)
    const targets = [input.file_path, input.filePath, input.path].filter(value => value !== undefined)
    if (targets.length !== 1) throw new Error('Use one unambiguous read path')
    const target = await checkedSourcePath(root, cwd, targets[0])
    if (!(await lstat(target.absolute)).isFile()) throw new Error('Read target is not a regular source file')
    return
  }
  const glob = ['Glob', 'glob'].includes(invocation.name)
  const input = glob ? globSchema.parse(invocation.input) : grepSchema.parse(invocation.input)
  const base = await checkedSourcePath(root, cwd, input.path ?? cwd, true)
  if (glob) {
    if (!safeGlob(input.pattern)) throw new Error('Glob pattern is outside the qualified path syntax')
    const pieces = input.pattern.split('/')
    const literal = pieces.slice(0, pieces.findIndex(piece => /[*?\[\]{}!]/.test(piece)) < 0 ? pieces.length : pieces.findIndex(piece => /[*?\[\]{}!]/.test(piece)))
    await checkedSearchTree(root, path.resolve(base.absolute, ...literal))
    return
  }
  const grep = grepSchema.parse(input)
  if ([grep.glob, grep.include].some(pattern => pattern !== undefined && !safeGlob(pattern))) throw new Error('Search glob is outside the qualified path syntax')
  await checkedSearchTree(root, base.absolute)
}
