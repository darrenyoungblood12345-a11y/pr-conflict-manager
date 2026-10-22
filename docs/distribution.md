# Building and inspecting the Mac candidate

The current artifact is an **ad-hoc signed development build**. Its resource
signature can be verified, but it has no Developer ID identity or notarization.
The development signing profile uses only the JIT entitlement and does not enable
hardened runtime: ad-hoc components have no shared Team ID for hardened library
validation. A public release needs a separate Developer ID/hardened-runtime
configuration, notarization, and the outstanding acceptance results.

## Repeatable local workflow

On an Apple Silicon development Mac with Node and Go available:

```sh
npm ci
npm run check
npm run dist:mac
```

`dist:mac` builds the `.app`, signs its nested code and resource seal with the
explicit development identity, then creates these files under `release/`:

- `Agent-PR-Monitor-0.1.0-mac-arm64-development.zip`
- The matching `.zip.sha256` checksum.
- The matching `.json` inspection report.
- `Agent-PR-Monitor-0.1.0-mac-arm64-development.dmg`.
- The matching `.dmg.sha256` checksum and `.dmg.json` inspection report.

Versioned filenames follow `package.json`. The ZIP contains the app bundle;
runtime users need no Node, Go, npm packages, or Xcode installation. Each Mac
still needs its own Git clone and a supported, separately installed agent client.

The archive command stages built file contents, modes and symlinks in the OS
temporary directory. This avoids signing-incompatible Finder metadata added by
some Desktop/iCloud file providers after packaging. It does not modify source
extended attributes or system security settings. It validates the staged app,
creates the ZIP, extracts that exact ZIP and validates the extracted app again.
Only then does it publish the archive, report and SHA-256 checksum locally.

The DMG command uses the same temporary staging approach. It creates a compressed
read-only UDZO image containing `Agent PR Monitor.app` and an `Applications`
shortcut, verifies the image checksum with `hdiutil`, and mounts that exact image
read-only without opening Finder. It checks the mounted Applications shortcut
and runs strict package inspection against the mounted app. The image must detach
successfully before its DMG, checksum and portable inspection report are published.
If detaching fails, the command retains temporary files and prints the mount path
so it never attempts to recursively delete a live mounted filesystem.

To build either distribution from an already packaged app, without rebuilding it:

```sh
npm run archive:mac
npm run dmg:mac
# An optional .app path is supported by both commands:
npm run dmg:mac -- '/absolute/path/Agent PR Monitor.app'
```

The DMG does not add a Developer ID signature or notarization to the app. Its
report records verified image format, mounted-app inspection, and successful
detach; it explicitly retains `distributionTrusted: false`. Recipients can drag
the app to Applications, but macOS may block this development build because it
has not been notarized. Do not disable Gatekeeper or remove quarantine as part
of the distribution workflow.

```sh
cd release
shasum -a 256 -c Agent-PR-Monitor-0.1.0-mac-arm64-development.zip.sha256
shasum -a 256 -c Agent-PR-Monitor-0.1.0-mac-arm64-development.dmg.sha256
```

For a selected app already extracted to an ordinary local directory:

```sh
npm run inspect:mac -- '/absolute/path/Agent PR Monitor.app'
```

An optional `--report /absolute/path/new-report.json` writes a report outside
the inspected bundle. The output file must not already exist. Inspection is
read-only and fails on invalid signatures or unsupported native formats.

## What inspection establishes

- Every discovered native component is a thin arm64 Mach-O with a declared macOS
  deployment target no newer than the app’s 15.0 baseline.
- The app’s identifier, version, executable, native coordinator, external ESM
  bridge, parser runtime, and fourteen grammar WASM modules are present.
- Traversal is bounded, framework aliases are deduplicated, and bundle symlinks
  cannot escape. Known development-cache/private-profile paths are rejected in
  both files and ASAR member names. This is not a content-level secret scan.
- Strict deep code-signature verification passes. The report records static
  signature kind and explicitly leaves notarization unchecked.

These checks establish package structure and deployment declarations. Actual
execution on macOS 15/26/27, physical LAN behavior, notifications, Keychain
prompts, and each agent’s native gate behavior require the
[manual acceptance matrix](acceptance-checklist.md). Local ten-peer tests
supplement that matrix; ten processes on one Mac do not qualify ten physical Macs.

## Public distribution prerequisites

Use the user’s chosen Apple Developer identity and normal credential provisioning
before configuring a production signing/notarization run. Sign and verify every
embedded component, notarize and staple the candidate, then repeat clean-install
and update tests with that exact candidate hash. Publishing and Apple uploads
are separate actions; this local workflow does neither.

Primary references: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/distribution-overview),
[Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[Apple distribution signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).
