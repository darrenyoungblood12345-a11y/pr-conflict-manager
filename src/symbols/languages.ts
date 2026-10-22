import path from 'node:path'

export const LANGUAGE_CONFIGURATIONS = {
  javascript: { grammar: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  typescript: { grammar: 'typescript', extensions: ['.ts', '.mts', '.cts'] },
  tsx: { grammar: 'tsx', extensions: ['.tsx'] },
  python: { grammar: 'python', extensions: ['.py', '.pyi'] },
  go: { grammar: 'go', extensions: ['.go'] },
  rust: { grammar: 'rust', extensions: ['.rs'] },
  java: { grammar: 'java', extensions: ['.java'] },
  c: { grammar: 'c', extensions: ['.c'] },
  cpp: { grammar: 'cpp', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] },
  c_sharp: { grammar: 'c_sharp', extensions: ['.cs'] },
  ruby: { grammar: 'ruby', extensions: ['.rb'] },
  php: { grammar: 'php', extensions: ['.php'] },
  swift: { grammar: 'swift', extensions: ['.swift'] },
  kotlin: { grammar: 'kotlin', extensions: ['.kt', '.kts'] },
} as const

export type SupportedLanguage = keyof typeof LANGUAGE_CONFIGURATIONS

export const languageForPath = (filePath: string): SupportedLanguage | null => {
  const extension = path.extname(filePath).toLowerCase()
  return (Object.entries(LANGUAGE_CONFIGURATIONS).find(([, value]) => (value.extensions as readonly string[]).includes(extension))?.[0] as SupportedLanguage | undefined) ?? null
}
