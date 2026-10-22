import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_APP_PATH, inspectMacApp } from './macos-package.mjs'

const execute = promisify(execFile)
const APP_NAME = 'Agent PR Monitor.app'
const HDIUTIL = '/usr/bin/hdiutil'
const check = (condition, message) => { if (!condition) throw new Error(message) }
const commandOptions = { timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8' }

async function requireFile(path) {
  const stat = await lstat(path)
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'The created DMG must be a nonempty regular file.')
}

/** Build an untrusted development installer and inspect the exact image before
 * publishing. The injected boundaries let tests exercise failure cleanup without
 * mounting a disk or accepting a pretend app signature as release evidence.
 */
export async function createMacDmg({ appPath = DEFAULT_APP_PATH, outputDirectory = 'release', version }, options = {}) {
  const { runCommand = execute, inspectApp = inspectMacApp } = options
  check(process.platform === 'darwin' || options.runCommand, 'macOS disk-image tools are required to build a DMG.')
  check(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'Use the project package version for the DMG.')
  const source = resolve(appPath)
  const sourceStat = await lstat(source)
  check(basename(source) === APP_NAME && sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), `Select a built local ${APP_NAME} directory.`)
  const output = resolve(outputDirectory)
  const withinApp = relative(source, output)
  check(withinApp === '..' || withinApp.startsWith(`..${sep}`) || withinApp.startsWith(sep), 'Publish the DMG outside the app bundle.')
  await mkdir(output, { recursive: true })
  const outputStat = await lstat(output)
  check(outputStat.isDirectory() && !outputStat.isSymbolicLink(), 'The release output must be a local directory.')

  const temporary = await mkdtemp(join(tmpdir(), 'agent-pr-dmg-'))
  let publication
  let attached = false
  let attachAttempted = false
  let mayRemoveTemporary = true
  const mountPoint = join(temporary, 'mounted')
  const stem = `Agent-PR-Monitor-${version}-mac-arm64-development`
  const archiveName = `${stem}.dmg`
  const reportName = `${archiveName}.json`
  const checksumName = `${archiveName}.sha256`
  try {
    publication = await mkdtemp(join(output, '.dmg-publish-'))
    const payload = join(temporary, 'payload')
    const stagedApp = join(payload, APP_NAME)
    await mkdir(payload)
    // Copy built bytes, modes and symlinks, without source extended attributes.
    // Desktop file providers can add FinderInfo after the app was signed.
    await cp(source, stagedApp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    const stagedInspection = await inspectApp(stagedApp)
    check(stagedInspection.version === version, 'Rebuild the app before packaging its current version.')
    await symlink('/Applications', join(payload, 'Applications'))
    const archive = join(temporary, archiveName)
    await runCommand(HDIUTIL, [
      'create', '-srcfolder', payload, '-volname', 'Agent PR Monitor',
      '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', archive,
    ], { ...commandOptions, timeout: 300000 })
    await requireFile(archive)
    const format = await runCommand(HDIUTIL, ['imageinfo', archive, '-format'], commandOptions)
    check(format.stdout.trim() === 'UDZO', 'The DMG is not a read-only zlib-compressed UDZO image.')
    await runCommand(HDIUTIL, ['verify', archive], commandOptions)
    await mkdir(mountPoint)
    let inspection
    try {
      attachAttempted = true
      const attachment = await runCommand(HDIUTIL, [
        'attach', archive, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, '-plist',
      ], commandOptions)
      attached = true
      // Read machine-readable mount evidence from the exact attach operation.
      const attachmentPath = join(temporary, 'attachment.plist')
      await writeFile(attachmentPath, attachment.stdout)
      const converted = await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', attachmentPath], commandOptions)
      const entities = JSON.parse(converted.stdout)['system-entities']
      // hdiutil can report /private/var while tmpdir() uses its /var alias.
      // Resolve both locations through the filesystem, retaining the device
      // evidence from this exact attach operation and rejecting other mounts.
      const expectedMount = await realpath(mountPoint)
      const mounts = Array.isArray(entities) ? entities.filter(entity => entity && typeof entity['mount-point'] === 'string' && /^\/dev\/disk\d+(?:s\d+)*$/.test(entity['dev-entry'])) : []
      const locations = await Promise.allSettled(mounts.map(entity => realpath(entity['mount-point'])))
      check(locations.some(location => location.status === 'fulfilled' && location.value === expectedMount), 'The exact DMG did not mount at its requested inspection directory.')
      const applications = join(mountPoint, 'Applications')
      check((await lstat(applications)).isSymbolicLink() && await readlink(applications) === '/Applications', 'The mounted DMG has no valid Applications shortcut.')
      inspection = await inspectApp(join(mountPoint, APP_NAME))
      check(inspection.version === version, 'The mounted DMG contains a different app version.')
    } finally {
      if (attachAttempted) {
        try {
          await runCommand(HDIUTIL, ['detach', mountPoint], commandOptions)
          attached = false
        } catch (error) {
          // An attach timeout may have mounted the filesystem before failing.
          // Never recursively remove a live mount if detach is unsuccessful.
          const onOriginalFilesystem = (await lstat(mountPoint)).dev === (await lstat(temporary)).dev
          mayRemoveTemporary = !attached && onOriginalFilesystem
          if (!mayRemoveTemporary) throw new Error(`Could not detach the DMG at ${mountPoint}; temporary files were retained.`, { cause: error })
        }
      }
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    const portableInspection = Object.fromEntries(Object.entries(inspection).filter(([key]) => key !== 'appPath'))
    const report = {
      formatVersion: 1, buildKind: 'development', distributionTrusted: false,
      archive: archiveName, sha256, imageFormat: 'UDZO', imageVerified: true,
      mountedAppVerified: true, applicationsLinkVerified: true,
      mount: { readOnlyRequested: true, noBrowseRequested: true, detached: true },
      inspection: { appName: APP_NAME, ...portableInspection },
      outstanding: ['Developer ID signing and notarization', 'Physical multi-Mac and supported OS/client acceptance'],
    }
    await writeFile(join(temporary, reportName), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(temporary, checksumName), `${sha256}  ${archiveName}\n`)
    const names = [archiveName, checksumName, reportName]
    for (const name of names) await cp(join(temporary, name), join(publication, name))
    for (const name of names) await rename(join(publication, name), join(output, name))
    return { archive: join(output, archiveName), checksum: join(output, checksumName), report: join(output, reportName), sha256, imageVerified: true, mountedAppVerified: true }
  } finally {
    if (mayRemoveTemporary) await rm(temporary, { recursive: true, force: true })
    if (publication) await rm(publication, { recursive: true, force: true })
  }
}
