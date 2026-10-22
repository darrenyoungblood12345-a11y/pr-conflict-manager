import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { createServer, request } from 'node:https'
import type { Server } from 'node:https'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const MAX_PASSWORD_BYTES = 1024

export interface PasswordVerifier {
  salt: string
  key: string
}

export const createPasswordVerifier = async (password: string): Promise<PasswordVerifier> => {
  if (!password || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw new Error('A non-empty password of at most 1024 bytes is required')
  }
  const salt = randomBytes(32)
  const key = await scrypt(password, salt, 32) as Buffer
  return { salt: salt.toString('hex'), key: key.toString('hex') }
}

export const verifyPassword = async (password: string, verifier: PasswordVerifier): Promise<boolean> => {
  if (!password || Buffer.byteLength(password) > MAX_PASSWORD_BYTES
    || !/^[a-f0-9]{64}$/.test(verifier.salt) || !/^[a-f0-9]{64}$/.test(verifier.key)) return false
  const expected = Buffer.from(verifier.key, 'hex')
  const actual = await scrypt(password, Buffer.from(verifier.salt, 'hex'), 32) as Buffer
  return timingSafeEqual(actual, expected)
}

/** Phase 1 transport proof only; this does not enroll a Raft member or grant task permission. */
export const createPairingProofServer = (
  identity: { key: string; cert: string },
  verifier: PasswordVerifier,
): Server => {
  const attempts = new Map<string, { count: number; resetAt: number }>()
  const server = createServer({ ...identity, minVersion: 'TLSv1.3' }, async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST' || req.url !== '/pairing-proof') {
      res.writeHead(404).end('{"error":"not_found"}')
      return
    }
    const address = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const current = attempts.get(address)
    const attempt = current && current.resetAt > now ? current : { count: 0, resetAt: now + 60_000 }
    if (attempt.count >= 5) {
      res.writeHead(429).end('{"error":"rate_limited"}')
      return
    }
    attempt.count += 1
    attempts.set(address, attempt)
    // Bound retained network identities in the proof; production enrollment adds device identities.
    if (attempts.size > 128) attempts.delete(attempts.keys().next().value as string)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) {
          res.writeHead(413).end('{"error":"too_large"}')
          req.destroy()
          return
        }
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { password?: unknown }
      if (typeof input.password !== 'string' || !await verifyPassword(input.password, verifier)) {
        res.writeHead(401).end('{"error":"invalid_password"}')
        return
      }
      res.writeHead(200).end('{"verified":true,"authorityGranted":false}')
    } catch {
      if (!res.headersSent) res.writeHead(400).end('{"error":"invalid_request"}')
    }
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.maxConnections = 16
  return server
}

/** The peer's public certificate must already be trusted out of band; never auto-trust discovery. */
export const verifyPairingProof = (
  peer: { port: number; trustedCertificate: string },
  password: string,
): Promise<boolean> => new Promise((resolve, reject) => {
  const body = JSON.stringify({ password })
  const req = request({
    host: '127.0.0.1', port: peer.port, servername: 'localhost',
    ca: peer.trustedCertificate, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    method: 'POST', path: '/pairing-proof', timeout: 3000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    res.resume()
    res.on('end', () => resolve(res.statusCode === 200))
  })
  req.once('timeout', () => req.destroy(new Error('Pairing proof timed out')))
  req.once('error', () => reject(new Error('Peer identity or secure transport could not be verified')))
  req.end(body)
})
