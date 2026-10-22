import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const localGo = fileURLToPath(new URL('../.local/tools/go/bin/go', import.meta.url))
const toolDirectory = fileURLToPath(new URL('../.local/tools/', import.meta.url))

export const goCommand = process.env.AGENT_PR_GO
  ?? (existsSync(localGo) ? localGo : 'go')

export const goEnv = {
  ...process.env,
  GOTOOLCHAIN: 'local',
  GOCACHE: process.env.GOCACHE ?? `${toolDirectory}go-cache`,
  GOMODCACHE: process.env.GOMODCACHE ?? `${toolDirectory}go-modules`,
}
