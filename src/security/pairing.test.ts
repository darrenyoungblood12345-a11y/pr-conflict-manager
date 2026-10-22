import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPairingProofServer, createPasswordVerifier, verifyPairingProof, verifyPassword } from './pairing.js'

let directory = ''
let identity: { key: string; cert: string }
let otherCertificate = ''

const listen = (server: Server) => new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject)
    resolve()
  })
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-pr-tls-'))
  for (const name of ['peer', 'other']) {
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.crt`),
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    ], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error('OpenSSL is required for the TLS transport proof')
  }
  identity = {
    key: await readFile(join(directory, 'peer.key'), 'utf8'),
    cert: await readFile(join(directory, 'peer.crt'), 'utf8'),
  }
  otherCertificate = await readFile(join(directory, 'other.crt'), 'utf8')
})

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

describe('password verifier', () => {
  it('uses independent salts and rejects a wrong password', async () => {
    const first = await createPasswordVerifier('shared workspace password')
    const second = await createPasswordVerifier('shared workspace password')
    expect(first.salt).not.toBe(second.salt)
    expect(first.key).not.toContain('password')
    expect(await verifyPassword('shared workspace password', first)).toBe(true)
    expect(await verifyPassword('incorrect', first)).toBe(false)
  })
})

describe('TLS pairing transport proof', () => {
  it('requires the expected certificate and password without granting task authority', async () => {
    const verifier = await createPasswordVerifier('shared workspace password')
    const server = createPairingProofServer(identity, verifier)
    await listen(server)
    const port = (server.address() as AddressInfo).port
    try {
      expect(await verifyPairingProof({ port, trustedCertificate: identity.cert }, 'shared workspace password')).toBe(true)
      expect(await verifyPairingProof({ port, trustedCertificate: identity.cert }, 'wrong')).toBe(false)
      await expect(verifyPairingProof({ port, trustedCertificate: otherCertificate }, 'shared workspace password'))
        .rejects.toThrow('could not be verified')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rate limits repeated password attempts', async () => {
    const verifier = await createPasswordVerifier('shared workspace password')
    const server = createPairingProofServer(identity, verifier)
    await listen(server)
    const port = (server.address() as AddressInfo).port
    try {
      for (const _ of Array.from({ length: 5 })) {
        expect(await verifyPairingProof({ port, trustedCertificate: identity.cert }, 'wrong')).toBe(false)
      }
      expect(await verifyPairingProof({ port, trustedCertificate: identity.cert }, 'shared workspace password')).toBe(false)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
