import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { renderSiteTemplate, siteReleaseValues, validateDmgReport, validateSiteRelease, verifyRemoteRelease } from '../src/distribution/site-release.mjs'

const flags = new Set(process.argv.slice(2))
if ([...flags].some(flag => !['--local', '--verify-remote'].includes(flag)) || (flags.has('--local') && flags.has('--verify-remote'))) {
  throw new Error('Use build-site.mjs [--local | --verify-remote].')
}
const local = flags.has('--local')
const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const release = validateSiteRelease(JSON.parse(await readFile('site/release.json', 'utf8')), metadata.version)
if (flags.has('--verify-remote')) await verifyRemoteRelease(release)
const output = resolve(local ? '.local/site-preview' : '.local/site-dist')
await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'downloads', 'agent-pr-monitor'), { recursive: true })
await cp('site/assets', join(output, 'assets'), { recursive: true })
for (const name of ['styles.css', 'main.js']) await cp(join('site', name), join(output, name))
const template = await readFile('site/index.html', 'utf8')
await writeFile(join(output, 'index.html'), renderSiteTemplate(template, siteReleaseValues(release, { local })))
await writeFile(join(output, '.nojekyll'), '')

// Only the maintained instruction file is public, never generated session setup.
const skill = await readFile('skills/agent-pr-monitor/SKILL.md')
await writeFile(join(output, 'downloads', 'SKILL.md'), skill)
await writeFile(join(output, 'downloads', 'agent-pr-monitor', 'SKILL.md'), skill)
await promisify(execFile)('zip', ['-q', '-X', 'agent-pr-monitor-skill.zip', 'agent-pr-monitor/SKILL.md'], {
  cwd: join(output, 'downloads'),
})
await rm(join(output, 'downloads', 'agent-pr-monitor'), { recursive: true })

if (local) {
  const image = join('release', release.asset)
  const report = JSON.parse(await readFile(`${image}.json`, 'utf8'))
  validateDmgReport(report, release)
  if ((await stat(image)).size !== release.bytes) throw new Error('Local DMG byte size differs from release metadata.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(image)) hash.update(chunk)
  if (hash.digest('hex') !== release.sha256) throw new Error('Local DMG checksum differs from release metadata.')
  if ((await readFile(`${image}.sha256`, 'utf8')).trim() !== `${release.sha256}  ${release.asset}`) throw new Error('Local checksum file differs from release metadata.')
  for (const suffix of ['', '.sha256', '.json']) await cp(`${image}${suffix}`, join(output, 'downloads', release.asset + suffix))
}

// Audit local references under a project-site prefix, including images and downloads.
const html = await readFile(join(output, 'index.html'), 'utf8')
for (const match of html.matchAll(/(?:href|src)="(\.\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
  await stat(join(output, match[1]))
}
const downloads = await readdir(join(output, 'downloads'))
console.log(JSON.stringify({ directory: output, mode: local ? 'local' : 'github-pages', downloads }))
