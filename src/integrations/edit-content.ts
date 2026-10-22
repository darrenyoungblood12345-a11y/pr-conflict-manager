import type { ToolInvocation } from './gate.js'

const field = (input: Record<string, unknown>, aliases: string[]) => {
  const present = aliases.filter(alias => alias in input)
  return present.length === 1 && typeof input[present[0]] === 'string' ? input[present[0]] as string : undefined
}

const pathFields = ['file_path', 'filePath', 'path']
const replacementFields = ['old_string', 'oldString', 'new_string', 'newString', 'replace_all', 'replaceAll']
const onlyFields = (input: Record<string, unknown>, allowed: string[]) => Object.keys(input).every(key => allowed.includes(key))
const replacementInput = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter(([key]) => replacementFields.includes(key)))
const isReplacement = (input: Record<string, unknown>) => {
  const flags = ['replace_all', 'replaceAll'].filter(key => key in input)
  return onlyFields(input, replacementFields) && field(input, ['old_string', 'oldString']) !== undefined
    && field(input, ['new_string', 'newString']) !== undefined
    && flags.length <= 1 && flags.every(key => typeof input[key] === 'boolean')
}

/** Reject unknown modes even for whole-file claims: they may affect other paths. */
export const isModeledEditPayload = (invocation: ToolInvocation): boolean => {
  const { name, input } = invocation
  if (name === 'apply_patch') return onlyFields(input, ['command']) && typeof input.command === 'string'
  if (name === 'Delete') return onlyFields(input, pathFields)
  if (['Write', 'write'].includes(name)) return onlyFields(input, [...pathFields, 'content']) && typeof input.content === 'string'
  if (['Edit', 'edit'].includes(name)) return onlyFields(input, [...pathFields, ...replacementFields]) && isReplacement(replacementInput(input))
  if (['MultiEdit', 'multiedit'].includes(name)) {
    const edits = input.edits
    return onlyFields(input, [...pathFields, 'edits']) && Array.isArray(edits) && edits.length > 0 && edits.length <= 256
      && edits.every(edit => typeof edit === 'object' && edit !== null && !Array.isArray(edit) && isReplacement(edit))
  }
  return false
}

const replace = (source: string, input: Record<string, unknown>): string | undefined => {
  if (!onlyFields(input, replacementFields)) return undefined
  const before = field(input, ['old_string', 'oldString'])
  const after = field(input, ['new_string', 'newString'])
  const flags = ['replace_all', 'replaceAll'].filter(key => key in input)
  if (flags.length > 1 || flags.some(key => typeof input[key] !== 'boolean') || !before || after === undefined) return undefined
  const index = source.indexOf(before)
  if (index < 0) return undefined
  if (flags.length && input[flags[0]] === true) return source.split(before).join(after)
  if (source.indexOf(before, index + before.length) >= 0) return undefined
  return source.slice(0, index) + after + source.slice(index + before.length)
}

/** Reconstruct only documented native content edits with unambiguous payloads. */
export const proposedContent = (invocation: ToolInvocation, source: string): string | undefined => {
  if (['Write', 'write'].includes(invocation.name)) {
    return onlyFields(invocation.input, [...pathFields, 'content']) ? field(invocation.input, ['content']) : undefined
  }
  if (['Edit', 'edit'].includes(invocation.name)) {
    if (!onlyFields(invocation.input, [...pathFields, ...replacementFields])) return undefined
    const replacement = replacementInput(invocation.input)
    return replace(source, replacement)
  }
  if (['MultiEdit', 'multiedit'].includes(invocation.name)) {
    if (!onlyFields(invocation.input, [...pathFields, 'edits'])) return undefined
    const edits = invocation.input.edits
    if (!Array.isArray(edits) || edits.length === 0 || edits.length > 256) return undefined
    return edits.reduce<string | undefined>((text, edit: unknown) => text !== undefined
      && typeof edit === 'object' && edit !== null && !Array.isArray(edit)
      ? replace(text, edit as Record<string, unknown>) : undefined, source)
  }
  // Patch fuzzing, shell commands, and deletions need a separately proven model.
  return undefined
}
