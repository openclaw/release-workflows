#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

workflow_files=()
while IFS= read -r workflow_file; do
  workflow_files+=("$workflow_file")
done < <(find .github/workflows examples -type f \( -name '*.yml' -o -name '*.yaml' \) | LC_ALL=C sort)
(( ${#workflow_files[@]} > 0 ))

actionlint "${workflow_files[@]}"

node scripts/test-release-target-resolution.mjs
node scripts/test-release-source-boundary.mjs
node scripts/test-required-workflows.mjs
node scripts/test-signing-credential-preflight.mjs
node scripts/test-tag-freeze.mjs
node scripts/test-ci-check-event-filter.mjs
node scripts/test-ci-run-identity.mjs
node scripts/test-build-artifact-matrix.mjs
node scripts/test-split-host-build.mjs
node scripts/test-swift-cli-workflow.mjs
node scripts/test-swift-keychain-lifecycle.mjs
node scripts/test-swift-draft-isolation.mjs
node scripts/test-electron-workflow.mjs
node scripts/test-electron-signing.mjs
node scripts/test-electron-draft-context.mjs
node scripts/test-reproducible-rebuild.mjs
node scripts/test-go-cli-policy-inputs.mjs
node scripts/test-release-notes-extraction.mjs
node scripts/test-release-notes-headings.mjs
node scripts/test-draft-binding.mjs
node scripts/test-publication-source-binding.mjs
node scripts/test-homebrew-handoff.mjs
scripts/test-signature-assertions.sh

ruby -e '
  require "psych"
  ARGV.each do |path|
    parsed = Psych.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
    raise "#{path}: top level must be a mapping" unless parsed.is_a?(Hash)
  end
' "${workflow_files[@]}"

python3 scripts/validate-workflow-contracts.py

echo "workflow validation passed (${#workflow_files[@]} files)"
