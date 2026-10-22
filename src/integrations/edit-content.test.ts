import { expect, it } from 'vitest'
import { proposedContent } from './edit-content.js'
import type { ToolInvocation } from './gate.js'

const tool = (name: string, input: Record<string, unknown>): ToolInvocation => ({ name, input, sessionId: 's', cwd: '/repo' })

it('reconstructs exact single and sequential edits without ambiguous replacement semantics', () => {
  expect(proposedContent(tool('Edit', { old_string: 'one', new_string: 'two' }), 'one three')).toBe('two three')
  expect(proposedContent(tool('edit', { oldString: 'one', newString: 'two', replaceAll: true }), 'one one')).toBe('two two')
  expect(proposedContent(tool('Edit', { old_string: 'one', new_string: 'two' }), 'one one')).toBeUndefined()
  expect(proposedContent(tool('MultiEdit', { edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'two', new_string: 'three' }] }), 'one')).toBe('three')
  expect(proposedContent(tool('Write', { content: '' }), 'one')).toBe('')
})

it('refuses missing text, competing aliases, malformed edits, and opaque patch or shell payloads', () => {
  expect(proposedContent(tool('Edit', { old_string: 'one', oldString: 'one', new_string: 'two' }), 'one')).toBeUndefined()
  expect(proposedContent(tool('Edit', { old_string: '', new_string: 'two' }), 'one')).toBeUndefined()
  expect(proposedContent(tool('MultiEdit', { edits: [null] }), 'one')).toBeUndefined()
  expect(proposedContent(tool('apply_patch', { command: 'anything' }), 'one')).toBeUndefined()
})

it('refuses unmodeled write modes and per-edit path overrides instead of proving another operation', () => {
  expect(proposedContent(tool('Write', { content: 'two', append: true }), 'one')).toBeUndefined()
  expect(proposedContent(tool('Edit', { old_string: 'one', new_string: 'two', edits: [{ file_path: 'another.ts' }] }), 'one')).toBeUndefined()
  expect(proposedContent(tool('MultiEdit', { edits: [{ old_string: 'one', new_string: 'two', file_path: 'another.ts' }] }), 'one')).toBeUndefined()
})
