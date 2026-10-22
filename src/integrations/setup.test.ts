import { describe, expect, it } from 'vitest'
import { generateSetupSnippets } from './setup.js'

const options = { cliPath: '/opt/Agent PR Monitor/cli.js', nodePath: '/opt/node', endpointFile: '/private/endpoint.json', contextFile: '/private/session.json' }

describe('project setup snippet generation', () => {
  it('generates only project config fragments and includes explicit preservation instructions', () => {
    const setup = generateSetupSnippets('codex', options)
    expect(setup.files.map(file => file.path)).toEqual(['.codex/config.toml', '.codex/hooks.json'])
    expect(setup.notices.join(' ')).toContain('Preserve existing')
    expect(setup.files[1].contents).toContain('|| exit 2')
    expect(setup.files[1].contents).not.toContain('"token"')
  })

  it('sets Claude failure blocking and states its minimum version', () => {
    const setup = generateSetupSnippets('claude-code', options)
    const hooks = JSON.parse(setup.files[1].contents)
    expect(hooks.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block')
    expect(setup.notices.join(' ')).toContain('>=2.1.295')
  })

  it('sets Cursor failClosed and covers all Agent tools with preToolUse', () => {
    const setup = generateSetupSnippets('cursor', options)
    const hooks = JSON.parse(setup.files[1].contents)
    expect(hooks.hooks.preToolUse[0].failClosed).toBe(true)
  })

  it('generates an OpenCode local MCP command and a project plugin using the same bridge', () => {
    const setup = generateSetupSnippets('opencode', options)
    expect(JSON.parse(setup.files[0].contents).mcp.agent_pr_monitor.command).toEqual(['/opt/node', '/opt/Agent PR Monitor/cli.js', 'mcp', '--endpoint-file', options.endpointFile, '--context-file', options.contextFile])
    expect(setup.files[1].contents).toContain('createOpenCodePluginFromFiles')
  })
})
