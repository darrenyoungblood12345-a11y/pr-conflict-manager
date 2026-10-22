export const releaseAssetName = version => `Agent-PR-Monitor-${version}-mac-arm64-development.dmg`

export function validateSiteRelease(release, version) {
  if (!release || release.version !== version || release.buildKind !== 'development' || release.architecture !== 'arm64'
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(release.repository ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.tag ?? '')
    || release.asset !== releaseAssetName(version)
    || !/^[a-f0-9]{64}$/.test(release.sha256 ?? '')
    || !Number.isSafeInteger(release.bytes) || release.bytes < 1) {
    throw new Error('Configure a version-matched development DMG, repository, release tag, SHA-256, and byte size in site/release.json.')
  }
  return release
}

export function siteReleaseValues(release, { local = false } = {}) {
  const releaseUrl = `https://github.com/${release.repository}/releases/tag/${encodeURIComponent(release.tag)}`
  const base = local ? './downloads/' : `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/`
  const dmg = `${base}${release.asset}`
  return {
    VERSION: release.version,
    DMG_URL: dmg,
    DMG_SIZE: `${(release.bytes / 1_000_000).toFixed(1)} MB`,
    SHA256: release.sha256,
    CHECKSUM_URL: `${dmg}.sha256`,
    REPORT_URL: `${dmg}.json`,
    RELEASE_URL: releaseUrl,
    BUILD_LABEL: 'Development build',
  }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

export function renderSiteTemplate(template, values) {
  const rendered = template.replace(/\{\{([A-Z_0-9]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing site value: ${key}`)
    return escapeHtml(values[key])
  })
  if (/\{\{[^}]*\}\}/.test(rendered)) throw new Error('Unresolved site template value.')
  return rendered
}

export function validateDmgReport(report, release) {
  if (report.archive !== release.asset || report.sha256 !== release.sha256
    || report.buildKind !== 'development' || report.distributionTrusted !== false
    || report.imageVerified !== true || report.mountedAppVerified !== true
    || report.applicationsLinkVerified !== true || report.inspection?.version !== release.version) {
    throw new Error('The DMG inspection report does not match this verified development release.')
  }
}

export async function verifyRemoteRelease(release, request = fetch) {
  const values = siteReleaseValues(release)
  const fetchAsset = async (url, method = 'GET') => {
    const response = await request(url, { method, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Release asset unavailable: ${url} (HTTP ${response.status})`)
    return response
  }
  const results = await Promise.all([
    fetchAsset(values.DMG_URL, 'HEAD'),
    fetchAsset(values.CHECKSUM_URL),
    fetchAsset(values.REPORT_URL),
  ])
  const [image, checksum, report] = results
  if (Number(image.headers.get('content-length')) !== release.bytes) throw new Error('Published DMG byte size differs from release metadata.')
  const checksumText = await checksum.text()
  if (checksumText.trim() !== `${release.sha256}  ${release.asset}`) throw new Error('Published DMG checksum differs from release metadata.')
  validateDmgReport(await report.json(), release)
}
