import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectMacApp } from '../src/distribution/macos-package.mjs'

const execute = promisify(execFile)
const metadata = JSON.parse(await readFile('package.json', 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) || process.argv.length > 3) {
  throw new Error('Use the project package version and at most one packaged .app path.')
}
const appPath = resolve(process.argv[2] ?? 'release/Agent PR Monitor-darwin-arm64/Agent PR Monitor.app')
if (!(await lstat(appPath)).isDirectory() || (await lstat(appPath)).isSymbolicLink()) throw new Error('Archive a built local app directory.')
const output = resolve('release')
await mkdir(output, { recursive: true })
if (!(await lstat(output)).isDirectory() || (await lstat(output)).isSymbolicLink()) throw new Error('The release output must be a local directory.')
// File providers can add FinderInfo to a Desktop .app after it was signed.
// Stage only built file bytes, modes, and symlinks; do not alter source xattrs
// or system security settings. The ZIP is inspected outside provider storage.
const temporary = await mkdtemp(join(tmpdir(), 'agent-pr-distribution-'))
const publication = await mkdtemp(join(output, '.archive-publish-'))
const stem = `Agent-PR-Monitor-${metadata.version}-mac-arm64-development`
const archiveName = `${stem}.zip`
try {
  const stagedApp = join(temporary, basename(appPath))
  await cp(appPath, stagedApp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  const inspection = await inspectMacApp(stagedApp)
  if (inspection.version !== metadata.version) throw new Error('Rebuild the app before archiving its current version.')
  const archive = join(temporary, archiveName)
  await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, archive], { timeout: 120000 })
  const unpacked = join(temporary, 'unpacked')
  await execute('/usr/bin/ditto', ['-x', '-k', archive, unpacked], { timeout: 120000 })
  // Prove symlinks, executable permissions, runtime assets, and the resource
  // signature survive the exact archive a second Mac would receive.
  await inspectMacApp(join(unpacked, basename(appPath)))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const sha256 = hash.digest('hex')
  const reportName = `${stem}.json`
  const checksumName = `${archiveName}.sha256`
  const portableInspection = Object.fromEntries(Object.entries(inspection).filter(([key]) => key !== 'appPath'))
  await writeFile(join(temporary, reportName), JSON.stringify({
    formatVersion: 1, buildKind: 'development', distributionTrusted: false,
    archive: archiveName, sha256, archiveRoundTripVerified: true,
    inspection: { appName: basename(appPath), ...portableInspection },
    outstanding: ['Developer ID signing and notarization', 'Physical multi-Mac and supported OS/client acceptance'],
  }, null, 2) + '\n')
  await writeFile(join(temporary, checksumName), `${sha256}  ${archiveName}\n`)
  const names = [archiveName, reportName, checksumName]
  for (const name of names) await cp(join(temporary, name), join(publication, name))
  for (const name of names) await rename(join(publication, name), join(output, name))
  console.log(JSON.stringify({ archive: join(output, archiveName), report: join(output, reportName), sha256, archiveRoundTripVerified: true }))
} finally {
  await rm(temporary, { recursive: true, force: true })
  await rm(publication, { recursive: true, force: true })
}
