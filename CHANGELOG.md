# Changelog

## 1.0.0-alpha.3 - 2026-07-17

- Make macOS signing resolve the validated certificate by SHA-1 hash while temporarily scoping the ephemeral keychain into the user search list and restoring the original list on every exit path.

## 1.0.0-alpha.2 - 2026-07-17

- Gate releases on branch-required status contexts by default, with optional strict all-check enforcement and a conservative fallback for repositories without required checks.

## 1.0.0-alpha.1 - 2026-07-17

- Add the fleet-standard reusable Go CLI release workflow, independent macOS verification, Homebrew handoff, closeout PR, documentation, example caller, and validation.
