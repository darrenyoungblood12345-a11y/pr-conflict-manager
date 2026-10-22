import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXPECTED_BUNDLE_ID, inspectMacApp, PARSER_LANGUAGES, parseMachO } from './macos-package.mjs'

const temporary = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function binary({ cpu = 0x0100000c, minimum = 15 * 65536, command = 0x32, platform = 1 } = {}) {
  const size = command === 0x32 ? 24 : 16
  const buffer = Buffer.alloc(32 + size)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpu, 4)
  buffer.writeUInt32LE(2, 12)
  buffer.writeUInt32LE(1, 16)
  buffer.writeUInt32LE(size, 20)
  buffer.writeUInt32LE(command, 32)
  buffer.writeUInt32LE(size, 36)
  if (command === 0x32) {
    buffer.writeUInt32LE(platform, 40)
    buffer.writeUInt32LE(minimum, 44)
  } else buffer.writeUInt32LE(minimum, 40)
  return buffer
}

function archive(files = { 'package.json': { size: 2, offset: '0' } }) {
  const json = Buffer.from(JSON.stringify({ files }))
  const headerSize = Math.ceil((8 + json.length) / 4) * 4
  const buffer = Buffer.alloc(8 + headerSize + 2)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(headerSize, 4)
  buffer.writeUInt32LE(headerSize - 4, 8)
  buffer.writeUInt32LE(json.length, 12)
  json.copy(buffer, 16)
  return buffer
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'package-inspection-'))
  temporary.push(directory)
  const app = join(directory, 'Agent PR Monitor.app')
  const put = async (path, contents, mode = 0o644) => {
    const destination = join(app, path)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, contents, { mode })
    return destination
  }
  await put('Contents/Info.plist', '<plist/>')
  await put('Contents/MacOS/Agent PR Monitor', binary(), 0o755)
  await put('Contents/Resources/native/coordinator', binary({ minimum: 14 * 65536 }), 0o755)
  await put('Contents/Resources/app.asar', archive())
  await put('Contents/Resources/integrations/cli.js', 'export {}\n')
  await put('Contents/Resources/integrations/package.json', '{"type":"module"}\n')
  await put('Contents/Resources/parser-assets/web-tree-sitter.mjs', 'export {}\n')
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
  for (const language of PARSER_LANGUAGES) await put(`Contents/Resources/parser-assets/tree-sitter-${language}.wasm`, wasm)
  await put('Contents/Resources/parser-assets/web-tree-sitter.wasm', wasm)
  const plist = {
    CFBundleIdentifier: EXPECTED_BUNDLE_ID, CFBundleShortVersionString: '0.1.0',
    LSMinimumSystemVersion: '15.0', CFBundleExecutable: 'Agent PR Monitor',
  }
  const runCommand = vi.fn(async (command, args) => {
    if (command === '/usr/bin/plutil') return { stdout: JSON.stringify(plist), stderr: '' }
    if (command === '/usr/bin/codesign' && args[0] === '--verify') return { stdout: '', stderr: '' }
    if (command === '/usr/bin/codesign' && args[0] === '-dv') return { stdout: '', stderr: 'Signature=adhoc\n' }
    throw new Error('Unexpected command.')
  })
  return { app, directory, put, plist, runCommand }
}

describe('bounded Mach-O parsing', () => {
  it('reads actual arm64 build-version and legacy minimum-version commands', () => {
    expect(parseMachO(binary())).toEqual({ architecture: 'arm64', minimumMacOS: '15.0', deploymentCommands: ['LC_BUILD_VERSION'] })
    expect(parseMachO(binary({ command: 0x24, minimum: 12 * 65536 + 3 * 256 + 1 }))).toMatchObject({ minimumMacOS: '12.3.1', deploymentCommands: ['LC_VERSION_MIN_MACOSX'] })
  })

  it('rejects non-arm64 CPUs, universal headers, and truncated binaries', () => {
    expect(() => parseMachO(binary({ cpu: 0x01000007 }))).toThrow(/CPU/)
    const fat = binary()
    fat.writeUInt32BE(0xcafebabe, 0)
    expect(() => parseMachO(fat)).toThrow(/thin/)
    expect(() => parseMachO(binary().subarray(0, 31))).toThrow(/Truncated/)
    expect(() => parseMachO(binary().subarray(0, 40))).toThrow(/Truncated/)
  })

  it('rejects newer deployment targets and non-macOS platforms', () => {
    expect(() => parseMachO(binary({ minimum: 15 * 65536 + 256 }))).toThrow(/newer/)
    expect(() => parseMachO(binary({ minimum: 26 * 65536 }))).toThrow(/newer/)
    expect(() => parseMachO(binary({ platform: 2 }))).toThrow(/not macOS/)
    expect(() => parseMachO(binary({ minimum: 0 }))).toThrow(/Invalid/)
  })

  it('rejects missing deployment metadata and malformed sizes, counts, and tool tables', () => {
    expect(() => parseMachO(binary({ command: 1 }))).toThrow(/Missing/)
    for (const [offset, value] of [[36, 0], [36, 20], [36, 32], [16, 2], [20, 1024 * 1024 + 8], [52, 1]]) {
      const malformed = binary()
      malformed.writeUInt32LE(value, offset)
      expect(() => parseMachO(malformed)).toThrow()
    }
  })

  it('rejects conflicting deployment commands', () => {
    const first = binary()
    const second = binary({ command: 0x24, minimum: 14 * 65536 }).subarray(32)
    const conflicting = Buffer.concat([first, second])
    conflicting.writeUInt32LE(2, 16)
    conflicting.writeUInt32LE(40, 20)
    expect(() => parseMachO(conflicting)).toThrow(/conflicting/)
  })
})

describe('read-only macOS package inspection', () => {
  it('reports concrete binaries, ESM/parser assets, version and strictly verified ad-hoc signature', async () => {
    const { app, runCommand } = await fixture()
    const report = await inspectMacApp(app, { runCommand })
    expect(report).toMatchObject({
      bundleId: EXPECTED_BUNDLE_ID, version: '0.1.0', minimumMacOS: '15.0',
      assets: { externalCliFormat: 'esm', wasmModules: 15, archiveMembers: 1 },
      signature: { valid: true, kind: 'ad-hoc', notarization: 'not-checked' },
    })
    expect(report.binaries.map(item => [item.path, item.minimumMacOS])).toEqual([
      ['Contents/MacOS/Agent PR Monitor', '15.0'], ['Contents/Resources/native/coordinator', '14.0'],
    ])
    expect(report.assets.parserLanguages).toHaveLength(14)
    expect(runCommand.mock.calls.map(([command, args]) => [command, args.slice(0, -1)])).toEqual([
      ['/usr/bin/plutil', ['-convert', 'json', '-o', '-']],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2']],
      ['/usr/bin/codesign', ['-dv', '--verbose=4']],
    ])
    expect(runCommand.mock.calls.every(([, , options]) => options.timeout === 30000 && options.maxBuffer === 1024 * 1024)).toBe(true)
  })

  it('deduplicates framework aliases without dropping the real binary', async () => {
    const { app, put, runCommand } = await fixture()
    await put('Contents/Frameworks/Test.framework/Versions/A/Test', binary({ minimum: 13 * 65536 }), 0o755)
    const framework = join(app, 'Contents/Frameworks/Test.framework')
    await symlink('A', join(framework, 'Versions/Current'))
    await symlink('Versions/Current/Test', join(framework, 'Test'))
    const report = await inspectMacApp(app, { runCommand })
    expect(report.binaries).toHaveLength(3)
    expect(report.binaries.filter(item => item.path.includes('Test.framework')).map(item => item.path)).toEqual(['Contents/Frameworks/Test.framework/Versions/A/Test'])
    expect(report.traversal.symlinks).toBe(2)
  })

  it('rejects an escaping symlink before invoking system commands', async () => {
    const { app, directory, runCommand } = await fixture()
    await writeFile(join(directory, 'outside'), 'private')
    await symlink(join(directory, 'outside'), join(app, 'Contents/Resources/escape'))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/escapes/)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects development/private directories outside and inside the archive', async () => {
    const { app, put, runCommand } = await fixture()
    await put('Contents/Resources/.local/secret', 'private')
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/private profile/)
    await rm(join(app, 'Contents/Resources/.local'), { recursive: true })
    await put('Contents/Resources/profiles/private.json', 'encrypted-profile')
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/private profile/)
    await rm(join(app, 'Contents/Resources/profiles'), { recursive: true })
    await put('Contents/Resources/app.asar', archive({ dist: { files: { sessions: { files: { 'context.json': { size: 1, offset: '0' } } } } } }))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/private profile/)
  })

  it('rejects missing grammars, non-ESM external CLI, and invalid WASM', async () => {
    const { app, put, runCommand } = await fixture()
    await put('Contents/Resources/integrations/package.json', '{"type":"commonjs"}')
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/ESM/)
    await put('Contents/Resources/integrations/package.json', '{"type":"module"}')
    await put('Contents/Resources/parser-assets/web-tree-sitter.wasm', Buffer.alloc(8))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/WASM/)
    await put('Contents/Resources/parser-assets/web-tree-sitter.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
    await rm(join(app, 'Contents/Resources/parser-assets/tree-sitter-swift.wasm'))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow()
  })

  it('requires arm64 deployment evidence in each actual native executable', async () => {
    const { app, put, runCommand } = await fixture()
    await put('Contents/Resources/native/coordinator', binary({ cpu: 0x01000007 }))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/CPU/)
    await put('Contents/Resources/native/coordinator', Buffer.from('#!/bin/sh\nexit 0\n'))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/Unrecognized/)
  })

  it('allows executable vendor WASM only at qualified asset paths and still validates its header', async () => {
    const { app, put, runCommand } = await fixture()
    const grammar = join(app, 'Contents/Resources/parser-assets/tree-sitter-c.wasm')
    await chmod(grammar, 0o755)
    await expect(inspectMacApp(app, { runCommand })).resolves.toMatchObject({ assets: { wasmModules: 15 } })
    await put('Contents/Resources/parser-assets/tree-sitter-c.wasm', Buffer.from('bad-wasm'))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/WASM/)
    await put('Contents/Resources/parser-assets/tree-sitter-c.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
    await put('Contents/Resources/unrecognized.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 0o755)
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/Unrecognized/)
  })

  it('enforces bundle identity, baseline and safe executable name from plutil output', async () => {
    const { app, plist, runCommand } = await fixture()
    plist.CFBundleIdentifier = 'other.app'
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/identifier/)
    plist.CFBundleIdentifier = EXPECTED_BUNDLE_ID
    plist.LSMinimumSystemVersion = '15.1'
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/baseline/)
    plist.LSMinimumSystemVersion = '15.0'
    plist.CFBundleExecutable = '../outside'
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/executable name/)
  })

  it('fails on unsigned/invalid packages and does not claim certificate trust', async () => {
    const { app, runCommand } = await fixture()
    runCommand.mockImplementation(async (command, args) => {
      if (command === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: EXPECTED_BUNDLE_ID, CFBundleShortVersionString: '0.1.0', LSMinimumSystemVersion: '15.0', CFBundleExecutable: 'Agent PR Monitor' }) }
      if (args[0] === '--verify') throw new Error('resource seal invalid')
      return { stderr: 'Authority=Untrusted Test Certificate\n' }
    })
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/resource seal/)
    runCommand.mockImplementation(async (command, args) => {
      if (command === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: EXPECTED_BUNDLE_ID, CFBundleShortVersionString: '0.1.0', LSMinimumSystemVersion: '15.0', CFBundleExecutable: 'Agent PR Monitor' }) }
      return { stderr: args[0] === '-dv' ? 'Authority=Untrusted Test Certificate\n' : '' }
    })
    expect((await inspectMacApp(app, { runCommand })).signature).toEqual({ valid: true, kind: 'certificate', notarization: 'not-checked' })
  })

  it('bounds traversal and reads and refuses malformed archive metadata', async () => {
    const { app, put, runCommand } = await fixture()
    await expect(inspectMacApp(app, { runCommand, limits: { maxEntries: 1 } })).rejects.toThrow(/traversal/)
    await expect(inspectMacApp(app, { runCommand, limits: { maxReadBytes: 1 } })).rejects.toThrow(/read limit/)
    await put('Contents/Resources/app.asar', Buffer.alloc(16))
    await expect(inspectMacApp(app, { runCommand })).rejects.toThrow(/app.asar/)
  })
})
