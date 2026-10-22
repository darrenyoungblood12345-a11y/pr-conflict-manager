# LAN desktop review and local test evidence

This evidence concerns local desktop control logic and isolated fixtures. It
does not establish multi-Mac networking, discovery, firewall, sleep/wake, or OS
compatibility.

- `lan-invitation.test.ts` creates temporary self-signed CA certificates through
  the installed OpenSSL CLI. It verifies the expected device/workspace subject,
  CA/self-signature, fingerprint, validity window, bounds, literal LAN endpoints,
  and rejection of credential-bearing/public/ambiguous URLs. No peer is contacted.
- Desktop interfaces deliberately offer private IPv4 addresses first, IPv4
  link-local next, and the loopback testing option last. Unscoped link-local
  IPv6 cannot be a usable default with the current UDP4 discovery path. Native
  IPv6 protocol tests remain independent of desktop qualification.
- `workspace-pool.test.ts` uses injected stores, identities, activation, and
  status. It proves only a newly created workspace requests bootstrap; reopened
  creator profiles do not. Pending enrollment cannot open without an explicit
  pinned retry, which preserves the device identity, request ID, and stored
  verifier. Retry passwords are passed transiently to activation, never saved.
- Pool snapshots reject status belonging to another workspace/device and discard
  a status response that completed after selection changed. Admitted members
  are labeled as membership, rather than a live count of connected computers.
- `workspace-profiles.test.ts` uses an injected authenticated-encryption fixture,
  not the real macOS Keychain. It verifies private permissions, no plaintext
  fallback, encrypted/public identity consistency including enrollment pins,
  and per-profile save serialization under delayed encryption. Validated input
  is copied before waiting so callers cannot mutate a queued save.
- `invitation-review.test.ts` proves that editing an invitation, including
  editing it back to the original text, invalidates a pending asynchronous
  review. The password field and submission remain tied to the reviewed text
  revision and a fresh direct fingerprint comparison.

The desktop offers explicit saved-enrollment review/retry after a restart,
including when a different workspace is open. It blocks a known-active retry
target and clears the password/confirmation when the target/pin changes.
Activation must persist a replacement verifier and remove pending enrollment
only after the native helper confirms that specific password attempt as
verified; an old active membership alone is insufficient.

The main-process helper lifecycle uses a process-local child handle and
generation checks around serialized endpoint publication. An obsolete startup
can clean up only its own endpoint token/file and child process. Native crash
supervision, actual Keychain behavior, invitation/password UX, and cross-device
enrollment still need runtime coverage beyond these unit fixtures.
