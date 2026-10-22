// Public test-only identity. This private key never authenticates a real workspace.
export const TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCAUagAwIBAgIUA+0L8J6Gte7jaDulaNNuqNgQdckwBQYDK2VwMDUxMzAx
BgNVBAMMKm1hYy1hLndvcmtzcGFjZS1hLmFnZW50LXByLW1vbml0b3IuaW52YWxp
ZDAgFw0yNjEwMjExODU1MzJaGA8yMTI2MDkyNzE4NTUzMlowNTEzMDEGA1UEAwwq
bWFjLWEud29ya3NwYWNlLWEuYWdlbnQtcHItbW9uaXRvci5pbnZhbGlkMCowBQYD
K2VwAyEAS62tRJJ2uko/btSI+z5hxgt6JE5yWAckJDhCV+xKVGKjZjBkMB0GA1Ud
DgQWBBR0n5dDOjDRZVkrNnqRXrFjAvr3BjAfBgNVHSMEGDAWgBR0n5dDOjDRZVkr
NnqRXrFjAvr3BjASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAF
BgMrZXADQQBCVGbJ/5M6aJXZRHlbUwRoAzC+fQgKrd2M6MumXBepa8muif0o4Mvc
eEEuE/9icd89K5zZt2T0K9ehvTq9ovoD
-----END CERTIFICATE-----
`

export const TEST_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIB5jCCAZigAwIBAgIURD6YlD79XXzaZ1a6rf7RQGbFdr4wBQYDK2VwMDUxMzAx
BgNVBAMMKm1hYy1hLndvcmtzcGFjZS1hLmFnZW50LXByLW1vbml0b3IuaW52YWxp
ZDAgFw0yNjEwMjExODU1MzJaGA8yMTI2MDkyNzE4NTUzMlowNTEzMDEGA1UEAwwq
bWFjLWEud29ya3NwYWNlLWEuYWdlbnQtcHItbW9uaXRvci5pbnZhbGlkMCowBQYD
K2VwAyEAhBYEr2MfIsQn5ENq2ouosj39b3aMKIW7pCCz076o33ijgbcwgbQwDAYD
VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0lBBYwFAYIKwYBBQUHAwEG
CCsGAQUFBwMCMDUGA1UdEQQuMCyCKm1hYy1hLndvcmtzcGFjZS1hLmFnZW50LXBy
LW1vbml0b3IuaW52YWxpZDAdBgNVHQ4EFgQUTq6OjTtF2ogOWKpYWQErmjCss9Qw
HwYDVR0jBBgwFoAUdJ+XQzow0WVZKzZ6kV6xYwL69wYwBQYDK2VwA0EAXKzs/3Ue
jZ4eeTlFI4dTouTUBfx8Keug2asPh+MOpCvzECDhNQnR60Hr36EComwDiIIt8Xoy
c9Qotx/d3IW/CA==
-----END CERTIFICATE-----
`

export const TEST_LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH8dj1dcjsGAybF6cFguTmwc5JELg9aUm8rGKwsbEXFI
-----END PRIVATE KEY-----
`

import { sign } from 'node:crypto'
import type { SignedTaskReceipt, Task } from '../shared/contracts.js'
import type { AgentContext } from './schemas.js'
import { sampleContext, sampleTask } from './fixtures.test-support.js'

export const receiptContext = (root: string): AgentContext => ({
  ...sampleContext(root),
  offlineAuthority: { workspaceId: 'workspace-a', deviceId: 'mac-a', caCertPEM: TEST_CA_CERT },
})

export const signedReceipt = (task: Task = sampleTask(), overrides: Record<string, unknown> = {}): SignedTaskReceipt => {
  const bytes = Buffer.from(JSON.stringify({
    version: 1, workspaceId: 'workspace-a', issuerDeviceId: 'mac-a', task, commitIndex: 7,
    repository: { owner: 'acme', repo: 'project' }, ...overrides,
  }))
  return { payload: bytes.toString('base64url'), signature: sign(null, bytes, TEST_LEAF_KEY).toString('base64url'), certPEM: TEST_LEAF_CERT }
}
