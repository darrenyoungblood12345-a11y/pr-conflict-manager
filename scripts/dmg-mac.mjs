import { readFile } from 'node:fs/promises'
import { createMacDmg } from '../src/distribution/macos-dmg.mjs'

if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) {
  throw new Error('Usage: node scripts/dmg-mac.mjs [path.app]')
}
const metadata = JSON.parse(await readFile('package.json', 'utf8'))
console.log(JSON.stringify(await createMacDmg({ appPath: process.argv[2], version: metadata.version })))
