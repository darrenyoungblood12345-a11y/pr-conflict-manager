import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export const DEFAULT_APP_PATH = fileURLToPath(new URL('../../release/Agent PR Monitor-darwin-arm64/Agent PR Monitor.app', import.meta.url))
export const EXPECTED_BUNDLE_ID = 'dev.agentprmonitor.desktop'
export const PARSER_LANGUAGES = Object.freeze(['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'c_sharp', 'ruby', 'php', 'swift', 'kotlin'])

const HEADER_SIZE = 32
const MAX_LOAD_COMMAND_BYTES = 1024 * 1024
const MAX_MINIMUM_VERSION = 15 * 65536
const MACH_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
const WASM_NAMES = ['web-tree-sitter.wasm', ...PARSER_LANGUAGES.map(language => `tree-sitter-${language}.wasm`)]
const WASM_PATHS = new Set(WASM_NAMES.map(name => `Contents/Resources/parser-assets/${name}`))
const PRIVATE_NAMES = new Set(['.local', '.git', '.cache', '.npm', '.codex', '.claude', '.cursor', '.opencode', 'workspaces', 'sessions', 'agent-launchers', 'profiles', 'workspace-profiles', 'cache', 'caches', 'code cache', 'gpucache', 'indexeddb', 'local storage', 'session storage'])
const execute = promisify(execFile)

const versionString = value => `${value >>> 16}.${(value >>> 8) & 255}${(value & 255) ? `.${value & 255}` : ''}`
const inside = (root, target) => target === root || (!relative(root, target).startsWith(`..${sep}`) && relative(root, target) !== '..' && !relative(root, target).startsWith(sep))
const slash = value => value.split(sep).join('/')
const check = (condition, message) => { if (!condition) throw new Error(message) }

// Layout and constants follow Apple's public mach-o/loader.h. Only thin,
// little-endian arm64 is qualified; unsupported formats never imply success.
export function parseMachO(buffer) {
  check(Buffer.isBuffer(buffer) && buffer.length >= HEADER_SIZE, 'Truncated Mach-O header.')
  check(buffer.readUInt32LE(0) === 0xfeedfacf, 'Expected a thin 64-bit little-endian Mach-O; fat/other formats are unsupported.')
  check(buffer.readUInt32LE(4) === 0x0100000c, 'Mach-O CPU is not arm64.')
  const commandCount = buffer.readUInt32LE(16)
  const commandBytes = buffer.readUInt32LE(20)
  check(commandCount > 0 && commandCount <= 65536 && commandBytes <= MAX_LOAD_COMMAND_BYTES && commandCount * 8 <= commandBytes, 'Invalid or oversized Mach-O load-command table.')
  check(buffer.length >= HEADER_SIZE + commandBytes, 'Truncated Mach-O load-command table.')
  const deployments = []
  let position = HEADER_SIZE
  for (let index = 0; index < commandCount; index += 1) {
    check(position + 8 <= HEADER_SIZE + commandBytes, 'Truncated Mach-O load command.')
    const command = buffer.readUInt32LE(position)
    const size = buffer.readUInt32LE(position + 4)
    check(size >= 8 && size % 8 === 0 && position + size <= HEADER_SIZE + commandBytes, 'Invalid Mach-O load-command size.')
    if (command === 0x32) {
      check(size >= 24 && size === 24 + buffer.readUInt32LE(position + 20) * 8, 'Malformed LC_BUILD_VERSION.')
      check(buffer.readUInt32LE(position + 8) === 1, 'Mach-O deployment platform is not macOS.')
      deployments.push({ value: buffer.readUInt32LE(position + 12), command: 'LC_BUILD_VERSION' })
    } else if (command === 0x24) {
      check(size === 16, 'Malformed LC_VERSION_MIN_MACOSX.')
      deployments.push({ value: buffer.readUInt32LE(position + 8), command: 'LC_VERSION_MIN_MACOSX' })
    } else if ([0x25, 0x2f, 0x30].includes(command)) {
      throw new Error('Mach-O deployment platform is not macOS.')
    }
    position += size
  }
  check(position === HEADER_SIZE + commandBytes, 'Mach-O load-command count and size disagree.')
  check(deployments.length > 0 && deployments.every(item => item.value === deployments[0].value), 'Missing or conflicting Mach-O macOS deployment target.')
  const minimum = deployments[0].value
  check(minimum >= 10 * 65536, 'Invalid Mach-O macOS deployment target.')
  check(minimum <= MAX_MINIMUM_VERSION, `Mach-O requires macOS ${versionString(minimum)}, newer than the macOS 15.0 baseline.`)
  return {
    architecture: 'arm64', minimumMacOS: versionString(minimum),
    deploymentCommands: deployments.map(item => item.command),
  }
}

function assertCleanPath(path) {
  const parts = slash(path).split('/')
  check(!parts.some(part => PRIVATE_NAMES.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /^integration-endpoint(?:\..*)?\.json$/i.test(part)), `Development cache or private profile included: ${path}`)
}

async function walkApp(root, maxEntries, maxDepth) {
  const files = new Map()
  const directories = new Set()
  let entries = 0
  let symlinks = 0
  const visit = async (path, depth) => {
    check(depth <= maxDepth && ++entries <= maxEntries, 'App traversal limit exceeded.')
    assertCleanPath(relative(root, path))
    const linkStat = await lstat(path)
    if (linkStat.isSymbolicLink()) symlinks += 1
    const canonical = await realpath(path)
    check(inside(root, canonical), `App symlink escapes its bundle: ${relative(root, path)}`)
    assertCleanPath(relative(root, canonical))
    const stat = canonical === path && !linkStat.isSymbolicLink() ? linkStat : await lstat(canonical)
    if (stat.isDirectory()) {
      if (directories.has(canonical)) return
      directories.add(canonical)
      const children = []
      for await (const entry of await opendir(canonical)) {
        check(children.length < maxEntries - entries, 'App traversal limit exceeded.')
        children.push(entry.name)
      }
      children.sort()
      for (const name of children) await visit(join(canonical, name), depth + 1)
      return
    }
    check(stat.isFile(), `Unsupported special file in app: ${relative(root, path)}`)
    if (!files.has(canonical)) files.set(canonical, { path: canonical, stat })
  }
  await visit(root, 0)
  return { files, symlinks }
}

function createReader(maxReadBytes) {
  let bytesRead = 0
  return async (file, length, position = 0) => {
    check(Number.isSafeInteger(length) && length >= 0 && bytesRead + length <= maxReadBytes, 'App inspection read limit exceeded.')
    check(position + length <= file.stat.size, `Truncated file: ${file.path}`)
    bytesRead += length
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      check(stat.isFile() && stat.dev === file.stat.dev && stat.ino === file.stat.ino && stat.size === file.stat.size && stat.mtimeMs === file.stat.mtimeMs, 'App changed during inspection.')
      const buffer = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const result = await handle.read(buffer, offset, length - offset, position + offset)
        check(result.bytesRead > 0, `Truncated file: ${file.path}`)
        offset += result.bytesRead
      }
      return buffer
    } finally { await handle.close() }
  }
}

async function inspectArchive(file, read, maxEntries, maxDepth) {
  const prefix = await read(file, 16)
  const headerSize = prefix.readUInt32LE(4)
  const jsonSize = prefix.readUInt32LE(12)
  check(prefix.readUInt32LE(0) === 4 && headerSize >= 8 && headerSize <= 8 * 1024 * 1024 && prefix.readUInt32LE(8) === headerSize - 4 && jsonSize > 0 && jsonSize <= headerSize - 8 && headerSize + 8 <= file.stat.size, 'Invalid or oversized app.asar header.')
  const header = JSON.parse((await read(file, jsonSize, 16)).toString('utf8'))
  let members = 0
  const visit = (directory, path, depth) => {
    check(depth <= maxDepth && directory && typeof directory === 'object' && !Array.isArray(directory), 'Invalid app.asar directory.')
    for (const [name, entry] of Object.entries(directory)) {
      check(++members <= maxEntries && name !== '.' && name !== '..' && !/[\x00/\\]/.test(name) && name.length > 0, 'Invalid or oversized app.asar member list.')
      const memberPath = path ? `${path}/${name}` : name
      assertCleanPath(memberPath)
      check(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid app.asar member.')
      if (entry.files !== undefined) visit(entry.files, memberPath, depth + 1)
      if (entry.link !== undefined) {
        check(typeof entry.link === 'string' && !entry.link.startsWith('/') && !entry.link.split(/[\\/]/).includes('..'), 'Unsafe app.asar link.')
        assertCleanPath(entry.link)
      }
    }
  }
  visit(header.files, '', 0)
  return members
}

async function inspectSignature(root, runCommand, commandTimeoutMs) {
  try {
    await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', root], { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  } catch (error) {
    const output = typeof error?.stderr === 'string' ? error.stderr : error instanceof Error ? error.message : 'codesign failed'
    const details = output.split('\n').filter(line => line && !/^--(?:prepared|validated):/.test(line)).join('\n').slice(-1200)
    throw new Error(`Strict code signature verification failed: ${details}`)
  }
  const details = await runCommand('/usr/bin/codesign', ['-dv', '--verbose=4', root], { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`
  const kind = /^Signature=adhoc\r?$/m.test(output) ? 'ad-hoc' : /^Authority=\S.+$/m.test(output) ? 'certificate' : undefined
  check(kind, 'Verified signature has no recognized static signature kind.')
  return { valid: true, kind, notarization: 'not-checked' }
}

/** Read-only inspection. Any unknown, missing or failing requirement throws.
 * runCommand is injectable for deterministic fixtures; production uses the
 * system plutil/codesign tools, never a shell or package-provided executable.
 */
export async function inspectMacApp(appPath = DEFAULT_APP_PATH, options = {}) {
  const { runCommand = execute, limits = {} } = options
  check(process.platform === 'darwin' || options.runCommand, 'macOS plutil and codesign are required to inspect an app.')
  const { maxEntries = 20000, maxDepth = 48, maxReadBytes = 32 * 1024 * 1024, commandTimeoutMs = 30000 } = limits
  check([maxEntries, maxDepth, maxReadBytes, commandTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0), 'Invalid inspection limits.')
  check(maxEntries <= 100000 && maxDepth <= 128 && maxReadBytes <= 128 * 1024 * 1024 && commandTimeoutMs <= 120000, 'Inspection limits exceed supported bounds.')
  const selected = resolve(appPath)
  check(extname(selected) === '.app', 'Select a macOS .app bundle.')
  const root = await realpath(selected)
  check((await lstat(root)).isDirectory(), 'App bundle is not a directory.')
  const { files, symlinks } = await walkApp(root, maxEntries, maxDepth)
  const read = createReader(maxReadBytes)
  const requireFile = async (path, executable = false) => {
    const target = join(root, path)
    const canonical = await realpath(target)
    check(inside(root, canonical), `Required app asset escapes its bundle: ${path}`)
    const file = files.get(canonical)
    check(file && file.stat.size > 0, `Missing or empty app asset: ${path}`)
    check(!executable || (file.stat.mode & 0o111) !== 0, `App executable is not executable: ${path}`)
    return file
  }
  await requireFile('Contents/Info.plist')
  const plistResult = await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(root, 'Contents/Info.plist')], { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  const plist = JSON.parse(plistResult.stdout)
  check(plist.CFBundleIdentifier === EXPECTED_BUNDLE_ID, 'Unexpected app bundle identifier.')
  check(typeof plist.CFBundleShortVersionString === 'string' && /^\d+(?:\.\d+){1,2}$/.test(plist.CFBundleShortVersionString) && plist.CFBundleShortVersionString.length <= 32, 'Invalid app version.')
  check(typeof plist.LSMinimumSystemVersion === 'string' && /^15\.0(?:\.0)?$/.test(plist.LSMinimumSystemVersion), 'App Info.plist must declare the macOS 15.0 baseline.')
  const executable = plist.CFBundleExecutable
  check(typeof executable === 'string' && executable.length > 0 && executable.length <= 255 && basename(executable) === executable && !['.', '..'].includes(executable) && !/[\x00\\/]/.test(executable), 'Invalid app executable name.')
  const main = await requireFile(`Contents/MacOS/${executable}`, true)
  const helper = await requireFile('Contents/Resources/native/coordinator', true)
  const binaries = []
  for (const file of files.values()) {
    const prefix = await read(file, Math.min(4, file.stat.size))
    const isMach = prefix.length === 4 && MACH_MAGICS.has(prefix.readUInt32LE(0))
    if (!isMach) {
      // Vendor WASM files carry executable permission bits. Only the exact
      // required assets are exempt, and each receives a WASM-v1 header check.
      const knownWasm = WASM_PATHS.has(slash(relative(root, file.path)))
      check(file !== main && file !== helper && (!(file.stat.mode & 0o111) || knownWasm) && !/\.(?:dylib|so|node)$/i.test(file.path) && !prefix.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `Unrecognized native/executable format: ${relative(root, file.path)}`)
      continue
    }
    const header = await read(file, HEADER_SIZE)
    const commandBytes = header.readUInt32LE(20)
    check(commandBytes <= MAX_LOAD_COMMAND_BYTES, 'Oversized Mach-O load-command table.')
    const commands = await read(file, commandBytes, HEADER_SIZE)
    binaries.push({ path: slash(relative(root, file.path)), ...parseMachO(Buffer.concat([header, commands])) })
  }
  const archive = await requireFile('Contents/Resources/app.asar')
  const archiveMembers = await inspectArchive(archive, read, maxEntries, maxDepth)
  const cli = await requireFile('Contents/Resources/integrations/cli.js')
  const cliPackage = await requireFile('Contents/Resources/integrations/package.json')
  check(cliPackage.stat.size <= 65536, 'Oversized external CLI package.json.')
  check(JSON.parse((await read(cliPackage, cliPackage.stat.size)).toString('utf8')).type === 'module', 'External CLI package.json must declare ESM.')
  const runtime = await requireFile('Contents/Resources/parser-assets/web-tree-sitter.mjs')
  for (const name of WASM_NAMES) {
    const wasm = await requireFile(`Contents/Resources/parser-assets/${name}`)
    check((await read(wasm, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), `Invalid WASM header: ${name}`)
  }
  const signature = await inspectSignature(root, runCommand, commandTimeoutMs)
  return {
    appPath: root, bundleId: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString,
    minimumMacOS: plist.LSMinimumSystemVersion, executable,
    binaries: binaries.sort((left, right) => left.path.localeCompare(right.path)),
    assets: {
      nativeHelper: 'Contents/Resources/native/coordinator',
      externalCli: slash(relative(root, cli.path)), externalCliFormat: 'esm',
      parserRuntime: slash(relative(root, runtime.path)), parserLanguages: [...PARSER_LANGUAGES],
      wasmModules: WASM_NAMES.length, archiveBytes: archive.stat.size, archiveMembers,
    },
    traversal: { uniqueFiles: files.size, symlinks, archivePathsChecked: true },
    signature,
  }
}
