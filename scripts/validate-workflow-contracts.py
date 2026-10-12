#!/usr/bin/env python3
"""Check release trust contracts from the repository root."""

from pathlib import Path
import re

workflow_paths = sorted(Path('.github/workflows').glob('*.y*ml')) + sorted(Path('examples').glob('*.y*ml'))
workflow = Path('.github/workflows/release-go-cli.yml').read_text()
required_jobs = ['validate', 'tag', 'build', 'build-split', 'merge-builds', 'sign', 'rebuild', 'compare', 'draft', 'verify', 'publish', 'handoff', 'closeout']
for job in required_jobs:
    if not re.search(rf'^  {re.escape(job)}:\s*$', workflow, re.MULTILINE):
        raise SystemExit(f'missing required job: {job}')

required_inputs = [
    'version', 'repository-type', 'homebrew-tap', 'homebrew-formula', 'extra-packages',
    'archive-files', 'checksum-filename', 'ci-check-events',
    'nfpm', 'build-runner', 'split-goreleaser-config', 'stable-identifier', 'require-signed-tag', 'darwin-universal',
    'strict-checks', 'reproducible-rebuild',
]
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
for required_nfpm_verifier_control in [
    ".kind? == \"nfpm\"",
    '.packageFormat == "deb" or .packageFormat == "rpm"',
    'nFPM package inventory mismatch',
    'verified nFPM package payloads by inventory-bound SHA-256',
]:
    if required_nfpm_verifier_control not in verify:
        raise SystemExit(f'missing checksum-only nFPM verifier control: {required_nfpm_verifier_control}')
for required_verify_attestation_control in [
    'needs.draft.outputs.verification-artifact-name',
    '--rawfile releaseNotes RELEASE-NOTES.md',
    '--rawfile sha256sums "$CHECKSUM_FILENAME"',
    '--arg checksumFilename "$CHECKSUM_FILENAME"',
    'checksumFilename:$checksumFilename',
    'verdict:"verified"',
    'payloadArtifact:$payloadArtifact',
    'releaseNotes:$releaseNotes',
    'verified-inventory-${{ matrix.arch }}-${{ needs.draft.outputs.verification-artifact-name }}',
    'retention-days: 30',
]:
    if required_verify_attestation_control not in verify:
        raise SystemExit(f'missing verifier attestation control: {required_verify_attestation_control}')

for required_cli_assessment_control in [
    'codesign --verify --strict --check-notarization -R=notarized',
]:
    if required_cli_assessment_control not in verify:
        raise SystemExit(f'missing CLI/app assessment policy: {required_cli_assessment_control}')
if 'spctl --assess' in verify:
    raise SystemExit('bare CLI verification must use codesign notarization, not app-bundle assessment')

publish = workflow.split('\n  publish:\n', 1)[1].split('\n  handoff:\n', 1)[0]
draft = workflow.split('\n  draft:\n', 1)[1].split('\n  verify:\n', 1)[0]
build = workflow.split('\n  build:\n', 1)[1].split('\n  sign:\n', 1)[0]
rebuild = workflow.split('\n  rebuild:\n', 1)[1].split('\n  compare:\n', 1)[0]
compare = workflow.split('\n  compare:\n', 1)[1].split('\n  draft:\n', 1)[0]
for required_build_control in [
    "inputs.split-goreleaser-config != '' && 'macos-15'",
    'NFPM_MODE: ${{ inputs.nfpm }}',
    'nfpm-enabled:',
    'release --config=$config --clean --timeout 60m --parallelism=2 --release-notes=/dev/null --skip=',
    'GORELEASER_CURRENT_TAG: ${{ needs.validate.outputs.tag }}',
    'goreleaser-version:',
]:
    if required_build_control not in build:
        raise SystemExit(f'missing build-mode control: {required_build_control}')
if not re.search(r'permissions:\s*\n\s*contents: read\s*$', rebuild, re.MULTILINE):
    raise SystemExit('reproducible rebuild job must grant only contents: read')
for required_rebuild_control in [
    "inputs.split-goreleaser-config != '' && 'ubuntu-latest'",
    'fetch-depth: 0',
    'version: ${{ needs.build.outputs.goreleaser-version }}',
    '[[ "$(go env GOVERSION)" == "$EXPECTED_GO_VERSION" ]]',
    'artifact-name=independent-rebuild-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
    'artifact-name: ${{ steps.rebuild-artifact-name.outputs.artifact-name }}',
    'path: reproducible-source/dist',
    'include-hidden-files: true',
    'go-version: ${{ needs.build.outputs.go-setup-version }}',
    'install-only: true',
    'without credentials',
    'unset GH_TOKEN GITHUB_TOKEN ACTIONS_RUNTIME_TOKEN',
    'env -i',
]:
    if required_rebuild_control not in rebuild:
        raise SystemExit(f'missing independent rebuild control: {required_rebuild_control}')
if 'contents: write' in rebuild:
    raise SystemExit('reproducible rebuild job must not have release write access')
if 'signed-release-assets-' in rebuild:
    raise SystemExit('tag-controlled rebuild job must never receive the staged release payload')
if not re.search(r'permissions:\s*\n\s*actions: read\s*$', compare, re.MULTILINE):
    raise SystemExit('clean comparison job must grant only actions: read')
for required_compare_control in [
    'name: ${{ needs.rebuild.outputs.artifact-name }}',
    'signed-release-assets-${{ github.run_id }}',
    'artifact-name=reproducible-rebuild-proof-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
    'artifact-name: ${{ steps.proof-artifact-name.outputs.artifact-name }}',
    'reproducible rebuild mismatch for ${target}/${member}',
]:
    if required_compare_control not in compare:
        raise SystemExit(f'missing clean comparison control: {required_compare_control}')
for forbidden_compare_execution in ['actions/checkout', 'goreleaser/goreleaser-action', 'git -C']:
    if forbidden_compare_execution in compare:
        raise SystemExit(f'clean comparison job executes tag-controlled code: {forbidden_compare_execution}')
for forbidden_draft_rebuild_execution in ['goreleaser/goreleaser-action', 'reproducible-source']:
    if forbidden_draft_rebuild_execution in draft:
        raise SystemExit(f'draft job executes tag-controlled rebuild code: {forbidden_draft_rebuild_execution}')
for required_policy_control in [
    'Verify required SSH-signed tag',
    'Reverify required SSH-signed tag before publication',
    'gpg.ssh.allowedSignersFile="$policy" verify-tag "$TAG"',
    'STABLE_IDENTIFIER: ${{ inputs.stable-identifier }}',
    'identifier=${STABLE_IDENTIFIER:-"$IDENTIFIER_PREFIX.$repo_slug.$binary_slug"}',
    'DARWIN_UNIVERSAL: ${{ inputs.darwin-universal }}',
    'if [[ "$DARWIN_UNIVERSAL" != disabled && "$universal_count" == 0 ]]',
    "!['tar.gz', 'zip'].includes(archiveFormat)",
    'ARCHIVE_FILES: ${{ inputs.archive-files }}',
    'CHECKSUM_FILENAME: ${{ inputs.checksum-filename }}',
    'CI_CHECK_EVENTS: ${{ inputs.ci-check-events }}',
    'Ignoring ${check.name} from Actions event ${event}',
    'listWorkflowRunsForRepo',
    'retaining all checks',
]:
    if required_policy_control not in workflow:
        raise SystemExit(f'missing crawler compatibility policy control: {required_policy_control}')
if 'verification-artifact-name:' not in draft or 'retention-days: 30' not in draft:
    raise SystemExit('draft must export and retain its verification payload for the retry window')
for required_release_notes_control in [
    'needs.validate.outputs.release-notes-artifact-name',
    'cp validated-release-notes/RELEASE-NOTES.md release-assets/RELEASE-NOTES.md',
    "names.includes('RELEASE-NOTES.md')",
]:
    if required_release_notes_control not in draft:
        raise SystemExit(f'draft does not bind release notes: {required_release_notes_control}')
if 'Fleet draft. Publication requires' in draft:
    raise SystemExit('draft must not use placeholder release notes')
for required_publish_binding_control in [
    'actions: read',
    'contents: write',
    'verified-inventory-arm64-${{ needs.draft.outputs.verification-artifact-name }}',
    'verified-inventory-x86_64-${{ needs.draft.outputs.verification-artifact-name }}',
    'github.paginate(github.rest.repos.listReleaseAssets',
    "accept: 'application/octet-stream'",
    "crypto.createHash('sha256')",
    '${label} ${checksumFilename} bytes differ from verified attestation',
    'verified release notes differ between arm64 and x86_64 attestations',
    'verified asset inventory differs between arm64 and x86_64 attestations',
    '${label} RELEASE-NOTES.md bytes differ from verified attestation',
    '${label} ASSET-INVENTORY.json bytes differ from verified attestation',
    '${label} asset inventory mismatch',
    'getReleaseByTag',
    'existing public release identity or notes differ from verified attestation',
    "downloadReleaseAssets(existing.id, 'existing public release')",
    'deleteRelease({ ...context.repo, release_id: releaseId })',
    'body: verifiedReleaseNotes',
    'GH_TOKEN: ${{ github.token }}',
    '-H "Authorization: Bearer $GH_TOKEN"',
    "-H 'X-GitHub-Api-Version: 2022-11-28'",
]:
    if required_publish_binding_control not in publish:
        raise SystemExit(f'missing publisher draft-binding control: {required_publish_binding_control}')
if publish.index("crypto.createHash('sha256')") > publish.index('updateRelease'):
    raise SystemExit('publisher must hash draft assets before undrafting')
github_api_calls = publish.count('https://api.github.com/')
github_api_auth_headers = publish.count('Authorization: Bearer $GH_TOKEN')
if github_api_calls != github_api_auth_headers:
    raise SystemExit(
        f'every direct GitHub API call must be authenticated: calls={github_api_calls} auth_headers={github_api_auth_headers}'
    )

handoff = workflow.split('\n  handoff:\n', 1)[1].split('\n  closeout:\n', 1)[0]
for forbidden_handoff_contract in [
    'source_repository:',
    'version:',
    'release_id:',
    'correlation_id:',
    'inputs.repository-type',
]:
    if forbidden_handoff_contract in handoff:
        raise SystemExit(f'handoff retains an unsupported or coupled tap field: {forbidden_handoff_contract}')
for required_handoff_control in [
    'needs.validate.outputs.homebrew-tap',
    'verified-inventory-arm64-${{ needs.draft.outputs.verification-artifact-name }}',
    'verified-inventory-x86_64-${{ needs.draft.outputs.verification-artifact-name }}',
    "inputs: {\n                formula: process.env.FORMULA,\n                tag: process.env.TAG,\n                repository,\n                assets: homebrewAssetsJson,\n              }",
    'TAP_TOKEN cannot access configured Homebrew tap',
    'verified ${process.env.CHECKSUM_FILENAME} differs between arm64 and x86_64 attestations',
    'verified asset inventory differs between arm64 and x86_64 attestations',
    "const homebrewTargets = new Set(['darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64'])",
    'verified inventory lacks Homebrew assets',
    'runsBeforeDispatch',
    'priorRunIds',
    'run.display_title === expectedRunTitle',
    "run.actor?.login?.toLowerCase() === tapActor.data.login.toLowerCase()",
    "tapRun.conclusion !== 'success'",
    'SOURCE_DEFAULT_BRANCH: ${{ needs.validate.outputs.default-branch }}',
    "['-rripper', '-rjson', '-e', analyzerProgram]",
    'formula must contain one class',
    'unsupported load-time formula statement',
    'formula head is not the exact source repository default branch',
    'return nil if value.match?(/[\\\\\\x00-\\x1f\\x7f]/)',
    "const rawComponents = url.pathname.split('/')",
    "const decodedSeparator = components.some((component) => component.includes('/') || component.includes('\\\\'))",
    "url.username || url.password || rawComponents.length !== 7",
    "components[5] !== process.env.TAG",
    'url.port ||',
    'formula sha256 mismatch for ${asset}',
    'Formula/${process.env.FORMULA}.rb',
    'HOMEBREW_POLL_TIMEOUT_MS ?? 900000',
]:
    if required_handoff_control not in handoff:
        raise SystemExit(f'missing Homebrew handoff control: {required_handoff_control}')
if not re.search(r'permissions:\s*\n\s*actions: read\s*$', handoff, re.MULTILINE):
    raise SystemExit('handoff source token must grant only actions: read')

sign = workflow.split('\n  sign:\n', 1)[1].split('\n  rebuild:\n', 1)[0]
for required_package_assembly_control in [
    "artifact.type === 'Linux Package'",
    'GoReleaser emitted no Linux Package artifacts',
    "path.join(releaseDirectory, '.NFPM-PACKAGES.json')",
    "path.join(releaseDirectory, '.ASSET-BINARIES.json')",
    "platform: `linux_${artifact.goarch}`",
    'archive file collides with a built payload',
    'staged archive-files inventory mismatch',
]:
    if required_package_assembly_control not in sign:
        raise SystemExit(f'missing nFPM package assembly control: {required_package_assembly_control}')
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
for required_notes_extraction_control in [
    'release-notes-artifact-name:',
    'exactly one dated level-two section',
    'Path(output).write_bytes(section.encode("utf-8"))',
    'Upload frozen release notes',
    'release-notes-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT',
]:
    if required_notes_extraction_control not in validate:
        raise SystemExit(f'validate does not freeze exact release notes: {required_notes_extraction_control}')
for required_retry_control in [
    "existingTag.data.object.type !== 'tag'",
    "core.setOutput('tag-object-sha', tagObjectSha)",
    'targetSha = tagObject.data.object.sha',
    'basehead: `${targetSha}...${branchHead}`',
    "!['ahead', 'identical'].includes(comparison.data.status)",
    "core.setOutput('target-sha', targetSha)",
]:
    if required_retry_control not in validate:
        raise SystemExit(f'missing immutable retry control: {required_retry_control}')

for required_preflight_control in [
    'Validate signing credentials',
    'missing required release secret(s)',
    'MACOS_SIGNING_P12 MACOS_SIGNING_P12_PASSWORD',
    'ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY_P8',
]:
    if required_preflight_control not in validate:
        raise SystemExit(f'missing signing credential preflight: {required_preflight_control}')

tag = workflow.split('\n  tag:\n', 1)[1].split('\n  build:\n', 1)[0]
for required_tag_control in [
    'EXPECTED_TAG_OBJECT: ${{ needs.validate.outputs.tag-object-sha }}',
    'tag disappeared after validation',
    'existing.data.object.sha !== process.env.EXPECTED_TAG_OBJECT',
    'tag object changed after validation',
    'tag appeared after validation',
]:
    if required_tag_control not in tag:
        raise SystemExit(f'missing exact tag freeze control: {required_tag_control}')

closeout = workflow.split('\n  closeout:\n', 1)[1]
for required_closeout_diagnostic in [
    'can_approve_pull_request_reviews=true',
    'Allow GitHub Actions to create and approve pull requests',
    'not permitted to create or approve pull requests',
]:
    if required_closeout_diagnostic not in closeout:
        raise SystemExit(f'missing closeout permission diagnostic: {required_closeout_diagnostic}')

all_workflows = '\n'.join(path.read_text() for path in workflow_paths)
unpinned = re.findall(r'^\s*uses:\s+(?:actions|goreleaser)/[^@\n]+@(v\d+|main|master)\s*(?:#.*)?$', all_workflows, re.MULTILINE)
if unpinned:
    raise SystemExit(f'unpinned action references: {unpinned}')


# Sparkle adds an environment approval gate before the existing publication boundary.
import json
import subprocess
sparkle = json.loads(subprocess.check_output([
    'ruby', '-rpsych', '-rjson', '-e',
    'puts JSON.generate(Psych.safe_load(File.read(ARGV[0]), aliases: false))',
    '.github/workflows/release-sparkle-app.yml',
], text=True))
sparkle_jobs = sparkle['jobs']
if set(sparkle_jobs) != {'validate', 'build', 'sign', 'package', 'tag', 'draft', 'verify', 'publish', 'handoff', 'closeout'}:
    raise SystemExit('invalid Sparkle job graph')
if sparkle_jobs['sign']['environment'] != '${{ inputs.signing-environment }}':
    raise SystemExit('Sparkle signing must select the approval-gated caller environment')
for job in ['sign', 'verify']:
    if sparkle_jobs[job]['permissions'] != {'actions': 'read'}:
        raise SystemExit(f'Sparkle {job} must have actions: read only')
for name, job in sparkle_jobs.items():
    source = json.dumps(job)
    if name != 'sign' and 'secrets.' in source:
        raise SystemExit(f'Sparkle secrets leaked outside signing: {name}')
    if name in ('sign', 'verify') and 'actions/checkout' in source:
        raise SystemExit(f'Sparkle {name} must not check out caller code')
    if name in ('tag', 'draft', 'publish', 'handoff', 'closeout') and '!inputs.dry-run' not in job.get('if', ''):
        raise SystemExit(f'Sparkle dry run must skip {name}')
    for step in job['steps']:
        if 'uses' in step and not re.fullmatch(r'[^@]+@[0-9a-f]{40}', step['uses']):
            raise SystemExit('Sparkle actions must have immutable SHA pins')
if sparkle_jobs['tag']['needs'] != ['validate', 'sign', 'package']:
    raise SystemExit('Sparkle tag must wait for successful approval, signing and packaging')
if [row['runner'] for row in sparkle_jobs['verify']['strategy']['matrix']['include']] != ['macos-15', 'macos-15-intel', 'macos-26']:
    raise SystemExit('Sparkle requires all three independent verifier runners')
if 'inputs.dry-run' not in sparkle_jobs['verify']['if'] or 'always()' not in sparkle_jobs['verify']['if']:
    raise SystemExit('Sparkle dry-run verification must survive the skipped draft job')
for name in ('build', 'sign', 'verify'):
    source = '\n'.join(step.get('run', '') for step in sparkle_jobs[name]['steps'])
    if "require(data.get('SURequireSignedFeed',False) is False" not in source or 'python3 "$RUNNER_TEMP/sparkle-tools/metadata.py"' not in source:
        raise SystemExit(f'Sparkle {name} must reject signed-feed requirements on the built app')
sign_steps = sparkle_jobs['sign']['steps']
capture_step = next(i for i, step in enumerate(sign_steps) if 'downloader.py" capture ' in step.get('run', ''))
identity_step = next(i for i, step in enumerate(sign_steps) if step.get('id') == 'signer')
if capture_step >= identity_step:
    raise SystemExit('Sparkle must freeze Downloader entitlements before importing signing credentials')
sign_source = '\n'.join(step.get('run', '') for step in sign_steps)
for control in ['downloader.py" sign "$app"', 'downloader.py" verify "$app"', "data['downloaderEntitlements']=json.loads(Path(e['RUNNER_TEMP'],'downloader-entitlements.json').read_text())"]:
    if control not in sign_source:
        raise SystemExit(f'missing Sparkle Downloader signing control: {control}')
verify_source = '\n'.join(step.get('run', '') for step in sparkle_jobs['verify']['steps'])
if 'downloader.py" verify-manifest "$app" release-assets/SIGNING-MANIFEST.json' not in verify_source:
    raise SystemExit('every Sparkle verifier must check frozen Downloader entitlements')
call = sparkle['on']['workflow_call'] if 'on' in sparkle else sparkle['true']['workflow_call']
required_sparkle_secrets = {'MACOS_SIGNING_P12', 'MACOS_SIGNING_P12_PASSWORD', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_P8', 'SPARKLE_PRIVATE_KEY'}
if set(call['secrets']) != required_sparkle_secrets or not all(s['required'] for s in call['secrets'].values()):
    raise SystemExit('Sparkle must declare six explicitly required secret names')
example = json.loads(subprocess.check_output([
    'ruby', '-rpsych', '-rjson', '-e',
    'puts JSON.generate(Psych.safe_load(File.read(ARGV[0]), aliases: false))',
    'examples/release-sparkle-app-caller.yml',
], text=True))
if example['jobs']['release']['secrets'] != {name: '${{ secrets.' + name + ' }}' for name in required_sparkle_secrets}:
    raise SystemExit('Sparkle example must pass the six secret names explicitly')
print('workflow trust contracts passed, including approval-gated Sparkle')
