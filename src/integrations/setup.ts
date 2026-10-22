import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentKind } from '../shared/contracts.js'

interface SetupOptions {
  cliPath: string
  endpointFile: string
  contextFile: string
  nodePath: string
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

export const PROJECT_INSTRUCTIONS = `Before repository work, call agent_pr_monitor read_plan and list_tasks. Use repository_status and list_symbols, or bounded native Read/Glob/Grep source inspection, to understand the selected clone before registering work. Propose a good task description, branch/base commit, and qualified functions to add/change/remove, including shared interfaces. Supported native Edit, Write, and MultiEdit payloads can admit a change strictly inside an existing, uniquely parsed reserved function. New functions/files, function boundary changes, unsupported or ambiguous parsing, and Codex apply_patch need whole-file reservations. Never start from a registration response alone: native gates verify the current task and reservation. Already accepted LAN work can continue offline only within its verified signed reservation; new tasks and scope expansion wait for authority. A later observed stop permanently revokes that revision's saved receipt. Only native file edits are gated; shell, tests, Git, and other tools follow the client's normal permissions, so never use them to write files outside your reservation. If blocked, stop subsequent edits, explain the exact conflict to the user, and use coordination tools to revise or abandon work. Acknowledge stopped only after all already-admitted/background writes finish. Link an existing PR using link_pull_request; report completion when editing ends. Reservations remain until stop acknowledgement and observed merge. Do not create or merge PRs through this coordination service. Generated adapters still require real-client verification for the installed version.`

export const generateSetupSnippets = (agent: AgentKind, options: SetupOptions) => {
  Object.values(options).forEach(value => {
    if (!path.isAbsolute(value) || value.includes('\n') || value.includes('\0')) throw new Error('Setup paths must be absolute and single-line')
  })
  const commonArgs = ['--endpoint-file', options.endpointFile, '--context-file', options.contextFile]
  const args = [options.cliPath, 'mcp', ...commonArgs]
  const mcp = { command: options.nodePath, args }
  const hookCommand = [options.nodePath, options.cliPath, 'hook', '--agent', agent, ...commonArgs].map(shellQuote).join(' ') + ' || exit 2'
  const files: Array<{ path: string; contents: string }> = []
  const notices = [
    'These are mergeable project snippets, not replacement configurations. Preserve existing keys, servers, rules, and hooks.',
    'Keep endpoint and session-context JSON outside the repository, owner-readable only (0600). Never commit tokens.',
    'Real-client denial, crash/timeout, subagent, and hook-trust qualification remains required for each installed version.',
  ]
  if (agent === 'codex') {
    files.push({
      path: '.codex/config.toml',
      contents: `[mcp_servers.agent_pr_monitor]\ncommand = ${JSON.stringify(options.nodePath)}\nargs = ${JSON.stringify(args)}\n`,
    }, {
      path: '.codex/hooks.json',
      contents: json({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }] } }),
    })
    notices.push('Trust the current project and exact hook definition using /hooks. Codex specialized tools may bypass hooks; a timeout is not qualified as a fail-closed stop.')
  }
  if (agent === 'claude-code') {
    files.push({ path: '.mcp.json', contents: json({ mcpServers: { agent_pr_monitor: mcp } }) }, {
      // Personal settings: the hook points at this Mac's private files and must never reach teammates.
      path: '.claude/settings.local.json',
      contents: json({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCommand, timeout: 10, onFailure: 'block' }] }] } }),
    })
    notices.push(
      'Requires Claude Code >=2.1.295 for onFailure:block. Verify the installed version before relying on failure blocking.',
      'Keep .claude/settings.local.json and .mcp.json out of Git: both reference private files on this Mac.',
    )
  }
  if (agent === 'cursor') {
    files.push({ path: '.cursor/mcp.json', contents: json({ mcpServers: { agent_pr_monitor: mcp } }) }, {
      path: '.cursor/hooks.json',
      contents: json({ version: 1, hooks: { preToolUse: [{ command: hookCommand, timeout: 10, failClosed: true }] } }),
    })
    notices.push('Use IDE Agent in a trusted workspace. Cursor CLI and Tab edits are not qualified by the Agent preToolUse hook.')
  }
  if (agent === 'opencode') {
    files.push({ path: 'opencode.json', contents: json({
      $schema: 'https://opencode.ai/config.json',
      mcp: { agent_pr_monitor: { type: 'local', command: [options.nodePath, ...args], enabled: true } },
    }) }, {
      path: '.opencode/plugins/agent-pr-monitor.mjs',
      contents: `import { createOpenCodePluginFromFiles } from ${JSON.stringify(pathToFileURL(options.cliPath).href)}\n\nexport const AgentPRMonitor = async ({ directory }) => createOpenCodePluginFromFiles({\n  endpointFile: ${JSON.stringify(options.endpointFile)},\n  contextFile: ${JSON.stringify(options.contextFile)},\n  cwd: directory,\n})\n`,
    })
    notices.push('OpenCode plugin loading, MCP tool-name mapping, and thrown-error stop behavior must be verified in the actual installed client.')
  }
  return { agent, files, instructions: PROJECT_INSTRUCTIONS, notices }
}
