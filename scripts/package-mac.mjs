import { packager } from '@electron/packager'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const metadata = JSON.parse(await readFile('package.json', 'utf8'))
const stage = resolve('.local/package-stage')
const native = resolve('.local/package-resources/native')
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await mkdir(native, { recursive: true })
await cp('dist', `${stage}/dist`, { recursive: true })
await cp('native/coordinator/bin/coordinator', `${native}/coordinator`)
await writeFile(`${stage}/package.json`, JSON.stringify({
  name: metadata.name, version: metadata.version, description: metadata.description,
  type: 'module', main: metadata.main,
}, null, 2))

const paths = await packager({
  dir: stage, out: resolve('release'), name: 'Agent PR Monitor',
  platform: 'darwin', arch: 'arm64', electronVersion: metadata.devDependencies.electron,
  appBundleId: 'dev.agentprmonitor.desktop', appCategoryType: 'public.app-category.developer-tools',
  darwinDarkModeSupport: true, appVersion: metadata.version, overwrite: true,
  extraResource: [native, resolve('dist/parser-assets'), resolve('dist/integrations')], asar: true, prune: false,
  extendInfo: { LSMinimumSystemVersion: '15.0' },
  // Seal every code/resource component for local development. The ad-hoc
  // identity does not use a Keychain certificate or imply notarization.
  osxSign: {
    identity: '-', identityValidation: false, type: 'development',
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    continueOnError: false,
    optionsForFile: () => ({
      entitlements: resolve('build/entitlements.development.plist'),
      // Ad-hoc code has no common Team ID for hardened library validation.
      // Public distribution requires a separate Developer ID release profile.
      hardenedRuntime: false, timestamp: 'none',
    }),
  },
  download: { cacheRoot: resolve('.local/electron-downloads') },
})
paths.forEach(path => console.log(path))
