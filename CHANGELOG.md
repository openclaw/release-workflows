# Changelog

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
