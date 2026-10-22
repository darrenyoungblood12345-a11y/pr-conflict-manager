import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { goCommand, goEnv } from './go-env.mjs'

mkdirSync('native/coordinator/bin', { recursive: true })
const result = spawnSync(goCommand, ['build', '-trimpath', '-o', 'bin/coordinator', './cmd/coordinator'], {
  cwd: 'native/coordinator',
  env: { ...goEnv, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' },
  stdio: 'inherit',
})
if (result.error) console.error('Go 1.26+ is required. Set AGENT_PR_GO to its executable path.')
process.exit(result.status ?? 1)
