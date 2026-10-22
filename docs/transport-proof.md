# Phase 1 transport proof

`src/security/pairing.ts` exercises standard TLS 1.3 with a trusted peer public
certificate and a salted scrypt password verifier. The client requires normal
certificate and hostname verification; it never uses `rejectUnauthorized:false`.
Wrong trust anchors fail before any authenticated application exchange. Password
requests are bounded and rate limited; password values are not included in errors.

Tests create temporary certificates with OpenSSL and verify the correct password,
wrong password, incorrect certificate, independent password salts, and retry
limits. The proof binds only loopback and deliberately grants no task authority
or voting membership.

Not yet implemented: password-based first-contact enrollment UI, securely
establishing peer identity trust, device key persistence/rotation/revocation,
native Raft TLS integration, and cross-Mac pairing. Bonjour discovery alone must
not supply trusted keys. This is a transport feasibility proof, not a completed
LAN security design or a claim that the loopback Raft harness is encrypted.
