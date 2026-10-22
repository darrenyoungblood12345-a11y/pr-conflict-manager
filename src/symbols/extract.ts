import type { Node } from 'web-tree-sitter'
import type { CodeSymbol } from './types.js'
import type { SupportedLanguage } from './languages.js'

const functionTypes = new Set([
  'function_declaration', 'generator_function_declaration', 'function_definition',
  'method_definition', 'method_declaration', 'function_item', 'method', 'singleton_method',
  'constructor_declaration', 'destructor_declaration', 'local_function_statement',
  'function_signature', 'method_signature', 'abstract_method_signature', 'function_signature_item',
  'init_declaration', 'deinit_declaration', 'secondary_constructor',
])
const containerTypes = new Set([
  'class_declaration', 'class_definition', 'class_specifier', 'struct_specifier', 'union_specifier',
  'namespace_definition', 'namespace_declaration', 'interface_declaration', 'enum_declaration',
  'struct_declaration', 'record_declaration', 'struct_item', 'enum_item', 'trait_item', 'mod_item',
  'class', 'module', 'trait_declaration', 'object_declaration', 'type_spec', 'type_alias_declaration',
])
const expressionFunctions = new Set(['arrow_function', 'function_expression', 'generator_function'])
const bindingTypes = new Set(['variable_declarator', 'pair', 'field_definition', 'public_field_definition'])
const identifierTypes = new Set([
  'identifier', 'type_identifier', 'field_identifier', 'property_identifier',
  'simple_identifier', 'constant', 'name', 'namespace_identifier',
])

const identifier = (node: Node | null): string | undefined => {
  if (!node) return undefined
  if (identifierTypes.has(node.type)) return node.text
  if (['qualified_identifier', 'scoped_identifier', 'scoped_type_identifier', 'qualified_name', 'scope_resolution', 'nested_namespace_specifier'].includes(node.type)) {
    return node.text.replaceAll('::', '.').replaceAll('\\', '.')
  }
  return undefined
}

const declaratorName = (node: Node | null): string | undefined => {
  if (!node) return undefined
  const direct = identifier(node)
  if (direct) return direct
  return declaratorName(node.childForFieldName('declarator'))
}

const nodeName = (node: Node, language: SupportedLanguage): string | undefined => {
  if (node.type === 'init_declaration') return 'init'
  if (node.type === 'deinit_declaration') return 'deinit'
  if (node.type === 'secondary_constructor') return 'constructor'
  if (node.type === 'function_definition' && (language === 'c' || language === 'cpp')) {
    return declaratorName(node.childForFieldName('declarator'))
  }
  const name = node.childForFieldName('name') ?? node.childForFieldName('key')
  if (name) return identifier(name)
  if (language === 'kotlin') {
    return identifier(node.namedChildren.find(child => child.type === (node.type === 'function_declaration' ? 'simple_identifier' : 'type_identifier')) ?? null)
  }
  return undefined
}

const receiverName = (node: Node): string | undefined => {
  const receiver = node.childForFieldName('receiver')
  const parameter = receiver?.namedChildren.find(child => child.type === 'parameter_declaration')
  const type = parameter?.childForFieldName('type')
  if (!type) return undefined
  if (type.type === 'type_identifier') return type.text
  if (type.type === 'pointer_type' && type.namedChildren.length === 1) return identifier(type.namedChildren[0])
  return undefined
}

const byteOffsets = (source: string) => {
  const offsets = new Uint32Array(source.length + 1)
  const position = { index: 0, byte: 0 }
  Array.from(source).forEach(character => {
    offsets[position.index] = position.byte
    if (character.length === 2) offsets[position.index + 1] = position.byte
    position.index += character.length
    position.byte += Buffer.byteLength(character, 'utf8')
    offsets[position.index] = position.byte
  })
  return offsets
}

const definitionRange = (node: Node) => node.parent?.type === 'decorated_definition' ? node.parent : node

export const extractSymbols = (root: Node, source: string, language: SupportedLanguage) => {
  const symbols: CodeSymbol[] = []
  const reasons: string[] = []
  const offsets = byteOffsets(source)
  const stack = [{ node: root, prefix: '' }]
  const visited = { count: 0 }
  while (stack.length > 0) {
    const { node, prefix } = stack.pop()!
    visited.count += 1
    if (visited.count > 100000) return { symbols: [], reason: 'Syntax tree exceeds the qualified analysis size' }
    const value = node.childForFieldName('value')
    const isBinding = bindingTypes.has(node.type) && value && (expressionFunctions.has(value.type) || ['object', 'class'].includes(value.type))
    const isContainer = containerTypes.has(node.type) && !(node.type === 'module' && language !== 'ruby')
    const isDefinition = functionTypes.has(node.type) || isContainer || isBinding
    const name = isDefinition ? nodeName(node, language) : undefined
    const receiver = language === 'go' && node.type === 'method_declaration' ? receiverName(node) : undefined
    const qualifiedName = name ? [receiver ?? prefix, name].filter(Boolean).join('.') : undefined
    if (isDefinition && !name) reasons.push(`Cannot reliably name ${node.type}; use a whole-file reservation`)
    if (language === 'go' && node.type === 'method_declaration' && !receiver) reasons.push('Cannot reliably qualify the Go method receiver')
    if (qualifiedName && name) {
      const range = definitionRange(node)
      symbols.push({
        name, qualifiedName,
        kind: functionTypes.has(node.type) || (isBinding && value && expressionFunctions.has(value.type)) ? 'function' : 'container',
        startByte: offsets[range.startIndex], endByte: offsets[range.endIndex],
        startLine: range.startPosition.row + 1,
        endLine: Math.max(range.startPosition.row + 1, range.endPosition.row + (range.endPosition.column === 0 ? 0 : 1)),
      })
    }
    const implementation = language === 'rust' && node.type === 'impl_item'
      ? identifier(node.childForFieldName('type')) : undefined
    if (language === 'rust' && node.type === 'impl_item' && !implementation) reasons.push('Cannot reliably qualify the Rust implementation type')
    const childPrefix = qualifiedName ?? (implementation ? [prefix, implementation].filter(Boolean).join('.') : prefix)
    node.namedChildren.slice().reverse().forEach(child => stack.push({ node: child, prefix: childPrefix }))
  }
  return {
    symbols: symbols.sort((left, right) => left.startByte - right.startByte || right.endByte - left.endByte),
    ...(reasons.length > 0 ? { reason: [...new Set(reasons)].join('; ') } : {}),
  }
}
