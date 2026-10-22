import { describe, expect, it } from 'vitest'
import { renderSiteTemplate, siteReleaseValues, validateDmgReport, validateSiteRelease, verifyRemoteRelease } from './site-release.mjs'

const release = {
  version: '0.1.0', buildKind: 'development', architecture: 'arm64',
  repository: 'example/monitor', tag: 'v0.1.0-development',
  asset: 'Agent-PR-Monitor-0.1.0-mac-arm64-development.dmg', sha256: 'a'.repeat(64), bytes: 12345,
}
const report = {
  archive: release.asset, sha256: release.sha256, buildKind: 'development', distributionTrusted: false,
  imageVerified: true, mountedAppVerified: true, applicationsLinkVerified: true, inspection: { version: '0.1.0' },
}

describe('landing page release contract', () => {
  it('refuses stale versions and malformed download destinations before publication', () => {
    expect(validateSiteRelease(release, '0.1.0')).toBe(release)
    for (const change of [
      { version: '0.2.0' }, { repository: 'example/monitor?token=secret' }, { tag: '../latest' },
      { sha256: null }, { asset: 'wrong.dmg' }, { bytes: -1 }, { architecture: 'x64' },
    ]) expect(() => validateSiteRelease({ ...release, ...change }, '0.1.0')).toThrow()
  })

  it('uses exact prerelease asset URLs and project-relative local downloads', () => {
    expect(siteReleaseValues(release).DMG_URL).toBe(`https://github.com/example/monitor/releases/download/v0.1.0-development/${release.asset}`)
    expect(siteReleaseValues(release, { local: true }).DMG_URL).toBe(`./downloads/${release.asset}`)
  })

  it('escapes release values and fails unresolved page metadata', () => {
    expect(renderSiteTemplate('<a title="{{VALUE}}">', { VALUE: '"<&' })).toBe('<a title="&quot;&lt;&amp;">')
    expect(() => renderSiteTemplate('{{VERSION}}', {})).toThrow('Missing site value')
    expect(() => renderSiteTemplate('{{unfinished}}', {})).toThrow('Unresolved')
  })

  it('requires successful mounted inspection and exact checksum/version evidence', () => {
    expect(() => validateDmgReport(report, release)).not.toThrow()
    for (const change of [
      { sha256: 'b'.repeat(64) }, { mountedAppVerified: false }, { imageVerified: false },
      { applicationsLinkVerified: false }, { inspection: { version: '0.0.9' } }, { distributionTrusted: true },
    ]) expect(() => validateDmgReport({ ...report, ...change }, release)).toThrow()
  })

  it('verifies remote files instead of silently publishing dead or mismatched links', async () => {
    const request = async (url, { method }) => {
      if (method === 'HEAD') return new Response(null, { headers: { 'content-length': String(release.bytes) } })
      return new Response(url.endsWith('.sha256') ? `${release.sha256}  ${release.asset}\n` : JSON.stringify(report))
    }
    await expect(verifyRemoteRelease(release, request)).resolves.toBeUndefined()
    await expect(verifyRemoteRelease(release, async () => new Response('', { status: 404 }))).rejects.toThrow('unavailable')
    await expect(verifyRemoteRelease(release, async (url, options) => options.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': '1' } }) : request(url, options))).rejects.toThrow('byte size')
  })
})
