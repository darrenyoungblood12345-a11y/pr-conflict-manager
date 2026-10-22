import { writeFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { DEFAULT_APP_PATH, inspectMacApp } from '../src/distribution/macos-package.mjs'

const args = process.argv.slice(2)
let appPath = DEFAULT_APP_PATH
let reportPath
let hasApp = false
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]
  if (value === '--report') {
    if (reportPath || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--report requires one output path.')
    reportPath = resolve(args[++index])
  } else {
    if (value.startsWith('-') || hasApp) throw new Error('Usage: node scripts/inspect-mac.mjs [path.app] [--report path.json]')
    appPath = resolve(value)
    hasApp = true
  }
}

try {
  const report = await inspectMacApp(appPath)
  if (reportPath) {
    const parent = await realpath(dirname(reportPath))
    const local = relative(report.appPath, parent)
    if (!local || (local !== '..' && !local.startsWith(`..${sep}`) && !local.startsWith(sep))) throw new Error('The report must be outside the inspected app bundle.')
    // Exclusive creation avoids following or overwriting a pre-existing file.
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  console.log(JSON.stringify({
    appPath: report.appPath, version: report.version, minimumMacOS: report.minimumMacOS,
    binaries: report.binaries.length, parserLanguages: report.assets.parserLanguages.length,
    signature: report.signature, ...(reportPath ? { reportPath } : {}),
  }, null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : 'Package inspection failed.'
  console.error(JSON.stringify({
    valid: false, error: message.slice(-1500),
    ...(/Finder information|resource fork|detritus/i.test(message) ? {
      hint: 'File-provider storage can add bundle metadata after signing. Inspect an explicitly staged app or the archive round trip. This command never changes metadata.',
    } : {}),
  }))
  process.exitCode = 1
}
