# Changelog

## Unreleased

- Add a protected organization-ruleset workflow that independently runs the
  Crabbox macOS release snapshot gate outside the target repository.

## v1.7.5 - 2026-08-03

- Retry transient GitHub 5xx responses while downloading verified release assets before publication across the Go, Swift, and Electron workflows.

## v1.7.4 - 2026-08-03

- Upgrade artifact downloads to `actions/download-artifact` v8.0.1 for the Node 24 runtime and fail-closed digest verification.

## v1.7.3 - 2026-08-03

- Wait for pending or not-yet-created CI checks on the exact frozen release commit while preserving immediate failure for terminal non-green results.

## v1.7.2 - 2026-08-02

- Make post-publication retries verify and reuse an identical public release, delete the redundant retry draft, and continue downstream handoff and closeout.

## v1.7.1 - 2026-08-02

- Accept literal Homebrew `version_scheme` metadata and adjacent complementary CPU branches while retaining fail-closed formula verification.

## v1.7.0 - 2026-08-02

- Add a reusable Electron desktop release pipeline for Go server assets plus signed, notarized, and stapled macOS DMG/ZIP apps, Windows NSIS/ZIP, Linux AppImage/DEB, exact checksum inventory, dual native verification, bound publication, and closeout.

## v1.6.1 - 2026-08-02

- Validate Swift CLI signing and notarization secrets before creating a consumer tag, and bind tag freezing to the exact annotated object observed during source validation.

## v1.6.0 - 2026-08-02

- Add a reusable SwiftPM CLI release pipeline with frozen-source tags, universal Darwin CLI and arm64e/arm64/x86_64 helper packaging, resource bundles, Developer ID signing and notarization, Linux archives, dual native verification, exact draft binding, Homebrew handoff, and closeout.

## v1.5.3 - 2026-08-02

- Fail before tag creation when required macOS signing or notarization credentials are unavailable, and reject tag refs that appear, disappear, or change after release-target validation.

## v1.5.2 - 2026-08-02

- Authenticate the post-publication GitHub API verification so anonymous rate limits cannot turn a successfully published release into a failed run before Homebrew handoff and closeout.

## v1.5.1 - 2026-08-02

- Keep signing, verification, publication, Homebrew handoff, and release
  closeout running when the optional split-host build is intentionally skipped,
  while still requiring every direct dependency to succeed.

## v1.5.0 - 2026-08-02

- Add optional split-host CGO builds that merge a macOS GoReleaser matrix with fixed-toolchain Linux/Windows outputs, route reproducible non-Darwin rebuilds through the split config, and allow versionless root `package.json` build manifests.

## v1.4.1 - 2026-07-27

- Bound primary and independent GoReleaser builds to two concurrent targets so memory-heavy callers can complete reliably with identical build scheduling.

## v1.4.0 - 2026-07-27

- Add an opt-in, fail-closed reproducible rebuild gate that independently rebuilds staged Linux and Windows binaries, requires byte identity, and records both digests in the verifier-bound asset inventory.

## v1.3.1 - 2026-07-27

- Let callers opt into event-scoped CI evidence so unrelated scheduled workflows on the same commit cannot permanently block release validation.

## v1.3.0 - 2026-07-27

- Preserve established checksum asset names and opt-in archive documentation files while keeping existing callers' release bytes unchanged by default.

## v1.2.0 - 2026-07-27

- Preserve GoReleaser's allowlisted per-target archive formats, add optional stable-identifier and SSH-signed-tag policies, and make the universal Darwin artifact configurable without weakening signing, notarization, inventory, or provenance verification.

## v1.1.1 - 2026-07-18

- Accept the live taps' closed, static `Hardware::CPU.arm?`/`intel?` platform branches, including the 64-bit qualifier, while continuing to reject dynamic Ruby evaluation.

## v1.1.0 - 2026-07-18

- Add auto-detected, overrideable nFPM `.deb`/`.rpm` assets with verifier-bound package metadata and checksums, plus an opt-in `macos-15` GoReleaser build host for native Darwin/CGO projects.

## v1.0.0-alpha.13 - 2026-07-18

- Bind Homebrew handoff to GoReleaser target metadata in the independently verified asset inventory, dispatch exact per-platform filenames and SHA-256 values, require tap-side download re-hashing, and update artifact actions to Node 24 releases.

## v1.0.0-alpha.12 - 2026-07-18

- Decouple Homebrew tap selection from signing identity, use the live three-field dispatcher contract, wait for its newly observed run, and require parser-validated formula release-asset hashes to match both verifier attestations.

## v1.0.0-alpha.11 - 2026-07-18

- Publish the exact dated changelog section as a verifier-attested, checksum-bound release body, and diagnose closeout PR failures with the required repository Actions workflow-permission settings.

## v1.0.0-alpha.10 - 2026-07-18

- Stop applying app-bundle `spctl --type execute` policy to bare Mach-O CLIs; retain strict signature, designated-requirement, hardened-runtime, and online notarization checks, with `spctl` guarded for future `.app` artifacts.

## v1.0.0-alpha.9 - 2026-07-18

- Move independent verification to the run's immutable Actions artifact with `actions: read` only, then bind every unpublished draft asset name and digest to both architecture attestations immediately before publication.

## v1.0.0-alpha.8
- Drop `target_commitish` from draft creation (Actions token rejects raw SHAs with 403); assert the frozen tag's peeled commit instead — same trust property, working API call.

## v1.0.0-alpha.7
- Extend notarization-ticket propagation wait to 15 minutes with exponential backoff (Apple CDN propagation regularly exceeds the previous 60s window).

## v1.0.0-alpha.6
- Normalize codesign's `/* exists */` display annotation in designated-requirement comparisons (both sign and verify normalizers).

## 1.0.0-alpha.5 - 2026-07-17

- Add labeled sanitized macOS signature diagnostics and normalize codesign's designated-requirement quote and `Executable=` display differences in both signing and independent verification.

## 1.0.0-alpha.4 - 2026-07-17

- Make retries reuse the existing annotated version tag's reachable peeled commit as the immutable validation and release target instead of trying to retarget it to a newer default-branch head.

## 1.0.0-alpha.3 - 2026-07-17

- Make macOS signing resolve the validated certificate by SHA-1 hash while temporarily scoping the ephemeral keychain into the user search list and restoring the original list on every exit path.

## 1.0.0-alpha.2 - 2026-07-17

- Gate releases on branch-required status contexts by default, with optional strict all-check enforcement and a conservative fallback for repositories without required checks.

## 1.0.0-alpha.1 - 2026-07-17

- Add the fleet-standard reusable Go CLI release workflow, independent macOS verification, Homebrew handoff, closeout PR, documentation, example caller, and validation.
