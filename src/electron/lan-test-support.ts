import { execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { LanPublic } from '../shared/lan.js'

const execute = promisify(execFile)

/** Only a temporary, local OpenSSL fixture. No peer/network operation occurs. */
export const lanInvitationFixture = async (ca = true) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-lan-invite-')))
  const workspaceId = 'test-workspace'
  const deviceId = 'test-peer'
  const certFile = path.join(directory, 'ca.pem')
  await execute('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', path.join(directory, 'ca.key'), '-out', certFile, '-days', '2', '-nodes',
    '-subj', `/CN=${deviceId}.${workspaceId}.agent-pr-monitor.invalid`,
    '-addext', `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}`, '-sha256',
  ], { timeout: 10000, maxBuffer: 65536 })
  const caCertPEM = await readFile(certFile, 'utf8')
  const certificate = new X509Certificate(caCertPEM)
  const invitation: LanPublic = {
    workspaceId, deviceId, caCertPEM,
    controlUrl: 'https://192.168.1.15:32100', raftEndpoint: '192.168.1.15:32101',
    fingerprint: createHash('sha256').update(certificate.raw).digest('hex'),
  }
  return { directory, invitation, certificate }
}
