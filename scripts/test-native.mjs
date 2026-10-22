import { spawnSync } from 'node:child_process'
import { goCommand, goEnv } from './go-env.mjs'

const result = spawnSync(goCommand, ['test', '-race', '-count=1', './...'], {
  cwd: 'native/coordinator', env: goEnv, stdio: 'inherit',
})
if (result.error) console.error('Go 1.26+ is required. Set AGENT_PR_GO to its executable path.')
process.exit(result.status ?? 1)
