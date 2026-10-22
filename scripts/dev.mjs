import { createServer } from 'vite'
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import electron from 'electron'

const native = spawnSync(process.execPath, ['scripts/build-native.mjs'], { stdio: 'inherit' })
if (native.status !== 0) process.exit(native.status ?? 1)
await build({
  entryPoints: ['src/electron/main.ts', 'src/electron/preload.ts'],
  outdir: 'dist/electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true,
})
const server = await createServer()
await server.listen()
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], { stdio: 'inherit', env })
const close = async () => {
  child.kill('SIGTERM')
  await server.close()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
child.once('exit', async code => { await server.close(); process.exit(code ?? 0) })
