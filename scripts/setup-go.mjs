import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This project toolchain setup targets Apple Silicon macOS.')
const filename = 'go1.27.3.darwin-arm64.tar.gz'
const expected = 'dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2'
const directory = fileURLToPath(new URL('../.local/tools/', import.meta.url))
await mkdir(directory, { recursive: true })
const response = await fetch(`https://dl.google.com/go/${filename}`, { redirect: 'error', signal: AbortSignal.timeout(120000) })
if (!response.ok) throw new Error(`Official Go download failed with HTTP ${response.status}.`)
const bytes = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Official Go archive checksum did not match the pinned release.')
const archive = path.join(directory, filename)
await writeFile(archive, bytes, { mode: 0o600 })
try { execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' }) }
finally { await unlink(archive) }
execFileSync(path.join(directory, 'go', 'bin', 'go'), ['version'], { stdio: 'inherit' })
