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
node scripts/test-draft-binding.mjs
scripts/test-signature-assertions.sh

ruby -e '
  require "psych"
  ARGV.each do |path|
    parsed = Psych.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
    raise "#{path}: top level must be a mapping" unless parsed.is_a?(Hash)
  end
' "${workflow_files[@]}"

python3 - <<'PY'
from pathlib import Path
import re

workflow_paths = sorted(Path('.github/workflows').glob('*.y*ml')) + sorted(Path('examples').glob('*.y*ml'))
workflow = Path('.github/workflows/release-go-cli.yml').read_text()
required_jobs = ['validate', 'tag', 'build', 'sign', 'draft', 'verify', 'publish', 'handoff', 'closeout']
for job in required_jobs:
    if not re.search(rf'^  {re.escape(job)}:\s*$', workflow, re.MULTILINE):
        raise SystemExit(f'missing required job: {job}')

required_inputs = ['version', 'repository-type', 'homebrew-formula', 'extra-packages', 'strict-checks']
for name in required_inputs:
    if not re.search(rf'^      {re.escape(name)}:\s*$', workflow, re.MULTILINE):
        raise SystemExit(f'missing workflow_call input: {name}')

verify = workflow.split('\n  verify:\n', 1)[1].split('\n  publish:\n', 1)[0]
for secret in ['MACOS_SIGNING_P12', 'MACOS_SIGNING_P12_PASSWORD', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_P8', 'TAP_TOKEN']:
    if f'secrets.{secret}' in verify:
        raise SystemExit(f'verify job references secret: {secret}')

if 'macos-14' not in verify or 'macos-15-intel' not in verify:
    raise SystemExit('verify matrix must cover arm64 and Intel macOS runners')

if not re.search(r'permissions:\s*\n\s*actions: read\s*$', verify, re.MULTILINE):
    raise SystemExit('verify job must grant only actions: read')
for forbidden_verify_release_access in [
    'contents: read',
    'getRelease',
    'listReleaseAssets',
    '/releases/assets/',
    'needs.draft.outputs.release-id',
]:
    if forbidden_verify_release_access in verify:
        raise SystemExit(f'verify job must not access draft releases: {forbidden_verify_release_access}')
for required_verify_attestation_control in [
    'needs.draft.outputs.verification-artifact-name',
    '--rawfile sha256sums SHA256SUMS',
    'verdict:"verified"',
    'payloadArtifact:$payloadArtifact',
    'verified-inventory-${{ matrix.arch }}-${{ needs.draft.outputs.verification-artifact-name }}',
    'retention-days: 30',
]:
    if required_verify_attestation_control not in verify:
        raise SystemExit(f'missing verifier attestation control: {required_verify_attestation_control}')

publish = workflow.split('\n  publish:\n', 1)[1].split('\n  handoff:\n', 1)[0]
draft = workflow.split('\n  draft:\n', 1)[1].split('\n  verify:\n', 1)[0]
if 'verification-artifact-name:' not in draft or 'retention-days: 30' not in draft:
    raise SystemExit('draft must export and retain its verification payload for the retry window')
for required_publish_binding_control in [
    'actions: read',
    'contents: write',
    'verified-inventory-arm64-${{ needs.draft.outputs.verification-artifact-name }}',
    'verified-inventory-x86_64-${{ needs.draft.outputs.verification-artifact-name }}',
    'github.paginate(github.rest.repos.listReleaseAssets',
    "accept: 'application/octet-stream'",
    "crypto.createHash('sha256')",
    'draft SHA256SUMS bytes differ from verified attestation',
    'draft asset inventory mismatch',
]:
    if required_publish_binding_control not in publish:
        raise SystemExit(f'missing publisher draft-binding control: {required_publish_binding_control}')
if publish.index("crypto.createHash('sha256')") > publish.index('updateRelease'):
    raise SystemExit('publisher must hash draft assets before undrafting')

sign = workflow.split('\n  sign:\n', 1)[1].split('\n  draft:\n', 1)[0]
for required_signing_control in [
    'echo "identity-hash=$identity_hash"',
    '--sign "$SIGNING_IDENTITY_HASH"',
    'security list-keychains -d user -s "${signing_search[@]}"',
    'if: always()',
    'security list-keychains -d user -s "${original_keychains[@]}"',
]:
    if required_signing_control not in sign:
        raise SystemExit(f'missing signing keychain control: {required_signing_control}')

for job_name, section in [('sign', sign), ('verify', verify)]:
    for required_signature_assertion in [
        'signature assertion failed [%s]',
        'expected (public metadata): %s',
        'observed (public metadata): %s',
        'normalize_designated_requirement',
        "sed -E '/^[[:space:]]*Executable=/d'",
        's/ Executable=.*$//',
        'observed_authorities=$(codesign_display_values Authority',
        'observed_timestamp=$(codesign_display_value Timestamp',
        'assert_signature_equal "designated-requirement"',
    ]:
        if required_signature_assertion not in section:
            raise SystemExit(
                f'missing labeled signature assertion in {job_name}: {required_signature_assertion}'
            )

validate = workflow.split('\n  validate:\n', 1)[1].split('\n  tag:\n', 1)[0]
for required_retry_control in [
    "existingTag.data.object.type !== 'tag'",
    'targetSha = tagObject.data.object.sha',
    'basehead: `${targetSha}...${branchHead}`',
    "!['ahead', 'identical'].includes(comparison.data.status)",
    "core.setOutput('target-sha', targetSha)",
]:
    if required_retry_control not in validate:
        raise SystemExit(f'missing immutable retry control: {required_retry_control}')

all_workflows = '\n'.join(path.read_text() for path in workflow_paths)
unpinned = re.findall(r'^\s*uses:\s+(?:actions|goreleaser)/[^@\n]+@(v\d+|main|master)\s*(?:#.*)?$', all_workflows, re.MULTILINE)
if unpinned:
    raise SystemExit(f'unpinned action references: {unpinned}')
PY

echo "workflow validation passed (${#workflow_files[@]} files)"
