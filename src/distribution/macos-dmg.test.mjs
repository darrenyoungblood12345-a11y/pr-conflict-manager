import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMacDmg } from './macos-dmg.mjs'

const temporary = new Set()
afterEach(async () => {
  await Promise.all([...temporary].map(path => rm(path, { recursive: true, force: true })))
  temporary.clear()
})

async function fixture({ failAt, malformedArtifact, wrongFormat = false, wrongMount = false, mountAlias = false, missingApplications = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dmg-packaging-test-'))
  temporary.add(root)
  const appPath = join(root, 'Agent PR Monitor.app')
  const outputDirectory = join(root, 'release')
  await mkdir(join(appPath, 'Contents/MacOS'), { recursive: true })
  await writeFile(join(appPath, 'Contents/MacOS/example'), 'app fixture\n', { mode: 0o755 })
  await chmod(join(appPath, 'Contents/MacOS/example'), 0o755)
  await symlink('MacOS/example', join(appPath, 'Contents/executable'))
  await mkdir(outputDirectory)
  await writeFile(join(outputDirectory, 'existing.zip'), 'retain existing ZIP')
  const state = { payload: undefined, mountPoint: undefined, reportedMountPoint: undefined, archive: undefined }
  const bytes = Buffer.from('disk image bytes supplied by system-command fixture')
  const runCommand = vi.fn(async (command, args) => {
    if (command === '/usr/bin/plutil') {
      return { stdout: JSON.stringify({ 'system-entities': [{ 'dev-entry': '/dev/disk999s1', 'mount-point': wrongMount ? '/other-volume' : state.reportedMountPoint ?? state.mountPoint }] }) }
    }
    expect(command).toBe('/usr/bin/hdiutil')
    const operation = args[0]
    if (operation === 'create') {
      state.payload = args[args.indexOf('-srcfolder') + 1]
      state.archive = args.at(-1)
      temporary.add(dirname(state.payload))
      if (failAt === operation) throw new Error('fixture create failed')
      if (malformedArtifact === 'symlink') await symlink(join(appPath, 'Contents/MacOS/example'), state.archive)
      else await writeFile(state.archive, malformedArtifact === 'empty' ? '' : bytes)
    } else if (operation === 'imageinfo') {
      return { stdout: wrongFormat ? 'UDRW\n' : 'UDZO\n' }
    } else if (operation === 'attach') {
      state.mountPoint = args[args.indexOf('-mountpoint') + 1]
      expect(args[1]).toBe(state.archive)
      expect(args).toEqual(expect.arrayContaining(['-readonly', '-nobrowse', '-noautoopen', '-plist']))
      if (failAt === operation) throw new Error('fixture attach failed')
      await cp(state.payload, state.mountPoint, { recursive: true, verbatimSymlinks: true })
      if (mountAlias) {
        state.reportedMountPoint = join(root, 'mount-alias')
        await symlink(state.mountPoint, state.reportedMountPoint)
      }
      if (missingApplications) await rm(join(state.mountPoint, 'Applications'))
      return { stdout: '<plist/>' }
    }
    if (failAt === operation) throw new Error(`fixture ${operation} failed`)
    return { stdout: '', stderr: '' }
  })
  const inspectApp = vi.fn(async selected => {
    if (failAt === 'inspect-mounted' && selected.includes('/mounted/')) throw new Error('fixture mounted signature failed')
    expect(await readFile(join(selected, 'Contents/MacOS/example'), 'utf8')).toBe('app fixture\n')
    expect((await lstat(join(selected, 'Contents/MacOS/example'))).mode & 0o777).toBe(0o755)
    expect(await readlink(join(selected, 'Contents/executable'))).toBe('MacOS/example')
    return {
      appPath: selected, version: '0.1.0', minimumMacOS: '15.0',
      signature: { valid: true, kind: 'ad-hoc', notarization: 'not-checked' },
    }
  })
  return { root, appPath, outputDirectory, runCommand, inspectApp, bytes, state }
}

const build = context => createMacDmg({ appPath: context.appPath, outputDirectory: context.outputDirectory, version: '0.1.0' }, { runCommand: context.runCommand, inspectApp: context.inspectApp })
const operations = context => context.runCommand.mock.calls.map(([command, args]) => command.endsWith('plutil') ? 'plutil' : args[0])

describe('development DMG packaging', () => {
  it('preserves executable modes and symlinks and publishes only a verified, detached image with matching portable evidence', async () => {
    const context = await fixture()
    const result = await build(context)
    const sha256 = createHash('sha256').update(context.bytes).digest('hex')
    const name = 'Agent-PR-Monitor-0.1.0-mac-arm64-development.dmg'
    expect(await readFile(result.archive)).toEqual(context.bytes)
    expect(await readFile(result.checksum, 'utf8')).toBe(`${sha256}  ${name}\n`)
    const report = JSON.parse(await readFile(result.report, 'utf8'))
    expect(report).toMatchObject({
      formatVersion: 1, buildKind: 'development', distributionTrusted: false,
      archive: name, sha256, imageFormat: 'UDZO', imageVerified: true,
      mountedAppVerified: true, applicationsLinkVerified: true,
      mount: { readOnlyRequested: true, noBrowseRequested: true, detached: true },
      inspection: { appName: 'Agent PR Monitor.app', version: '0.1.0', signature: { kind: 'ad-hoc', notarization: 'not-checked' } },
    })
    expect(report.inspection).not.toHaveProperty('appPath')
    expect(JSON.stringify(report)).not.toContain(context.root)
    expect(operations(context)).toEqual(['create', 'imageinfo', 'verify', 'attach', 'plutil', 'detach'])
    expect(context.inspectApp).toHaveBeenCalledTimes(2)
    expect(await readdir(context.outputDirectory)).toEqual(expect.arrayContaining([name, `${name}.sha256`, `${name}.json`, 'existing.zip']))
    expect(await readFile(join(context.outputDirectory, 'existing.zip'), 'utf8')).toBe('retain existing ZIP')
    await expect(lstat(dirname(context.state.payload))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(context.outputDirectory)).some(name => name.startsWith('.dmg-publish-'))).toBe(false)
  })

  it.each(['empty', 'symlink'])('rejects a %s image before verification or mounting', async malformedArtifact => {
    const context = await fixture({ malformedArtifact })
    await expect(build(context)).rejects.toThrow(/nonempty regular file/)
    expect(operations(context)).toEqual(['create'])
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
    await expect(lstat(dirname(context.state.payload))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['create', 'verify', 'attach', 'inspect-mounted'])('cleans staging and publishes nothing after a %s failure', async failAt => {
    const context = await fixture({ failAt })
    await expect(build(context)).rejects.toThrow(/fixture/)
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
    await expect(lstat(dirname(context.state.payload))).rejects.toMatchObject({ code: 'ENOENT' })
    if (failAt === 'attach' || failAt === 'inspect-mounted') expect(operations(context).at(-1)).toBe('detach')
    else expect(operations(context)).not.toContain('detach')
  })

  it('rejects a read-write format without mounting it', async () => {
    const context = await fixture({ wrongFormat: true })
    await expect(build(context)).rejects.toThrow(/UDZO/)
    expect(operations(context)).toEqual(['create', 'imageinfo'])
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
  })

  it('requires mount evidence for the requested directory and detaches even when that evidence is wrong', async () => {
    const context = await fixture({ wrongMount: true })
    await expect(build(context)).rejects.toThrow(/requested inspection directory/)
    expect(operations(context).at(-1)).toBe('detach')
    expect(context.inspectApp).toHaveBeenCalledTimes(1)
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
  })

  it('accepts a filesystem alias in attach evidence while inspecting and detaching the requested mount', async () => {
    const context = await fixture({ mountAlias: true })
    const result = await build(context)
    expect(context.state.reportedMountPoint).not.toBe(context.state.mountPoint)
    expect(JSON.parse(await readFile(result.report, 'utf8')).mountedAppVerified).toBe(true)
    expect(context.inspectApp).toHaveBeenLastCalledWith(join(context.state.mountPoint, 'Agent PR Monitor.app'))
    expect(context.runCommand).toHaveBeenLastCalledWith('/usr/bin/hdiutil', ['detach', context.state.mountPoint], expect.any(Object))
  })

  it('refuses an installer that lacks its Applications shortcut and still detaches', async () => {
    const context = await fixture({ missingApplications: true })
    await expect(build(context)).rejects.toThrow()
    expect(operations(context).at(-1)).toBe('detach')
    expect(context.inspectApp).toHaveBeenCalledTimes(1)
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
  })

  it('retains temporary files if detaching fails rather than recursively deleting a mounted volume', async () => {
    const context = await fixture({ failAt: 'detach' })
    await expect(build(context)).rejects.toThrow(/Could not detach.*temporary files were retained/)
    expect((await lstat(dirname(context.state.payload))).isDirectory()).toBe(true)
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
  })

  it('rejects a stale app version before running disk-image tools', async () => {
    const context = await fixture()
    context.inspectApp.mockResolvedValue({ version: '0.0.1' })
    await expect(build(context)).rejects.toThrow(/Rebuild/)
    expect(context.runCommand).not.toHaveBeenCalled()
    expect(await readdir(context.outputDirectory)).toEqual(['existing.zip'])
  })
})
