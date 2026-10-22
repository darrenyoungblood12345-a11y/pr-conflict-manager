/** An origin is data, never a URL to fetch. Remote observation uses api.github.com only. */
export const githubIdentity = (origin: string | undefined): { owner: string; repo: string } | null => {
  if (!origin || /[\p{Cc}\s]/u.test(origin)) return null
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(origin)
  const url = (() => { try { return new URL(origin) } catch { return null } })()
  const components = scp ? scp.slice(1) : url && ['https:', 'ssh:'].includes(url.protocol)
    && url.hostname === 'github.com' && !url.port && !url.password && !url.search && !url.hash
    && (!url.username || url.protocol === 'ssh:' && url.username === 'git')
    ? url.pathname.replace(/^\//, '').split('/') : []
  if (components.length !== 2) return null
  const [owner, rawRepo] = components
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!owner || !repo || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)
    || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() }
}
