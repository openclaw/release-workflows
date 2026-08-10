#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-swift-cli.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const section = (start, end) => workflow.split(`\n  ${start}:\n`, 2)[1].split(`\n  ${end}:\n`, 1)[0];

for (const job of ['validate', 'tag', 'build-macos', 'build-linux', 'sign', 'draft', 'verify', 'publish', 'handoff', 'closeout']) {
  assert.match(workflow, new RegExp(`^  ${job}:$`, 'm'), `missing job ${job}`);
}

for (const input of [
  'version', 'repository-type', 'homebrew-tap', 'homebrew-formula', 'binary-name', 'helper-name',
  'binary-identifier', 'helper-identifier', 'macos-archive-name', 'linux-archive-name',
  'version-file', 'macos-build-script', 'linux-build-script', 'prepare-script',
  'generate-version-script', 'entitlements-file', 'swift-linux-image', 'checksum-filename', 'ci-check-events',
]) {
  assert.match(workflow, new RegExp(`^      ${input}:$`, 'm'), `missing input ${input}`);
}

const buildMac = section('build-macos', 'build-linux');
const buildLinux = section('build-linux', 'sign');
const sign = section('sign', 'draft');
const draft = section('draft', 'verify');
const verify = section('verify', 'publish');
const publish = section('publish', 'handoff');
const handoff = section('handoff', 'closeout');
const validate = section('validate', 'tag');
const tag = section('tag', 'build-macos');

assert.match(validate, /Validate signing credentials/);
assert.match(validate, /missing required release secret\(s\)/);
assert.match(validate, /tag-object-sha/);
assert.match(tag, /EXPECTED_TAG_OBJECT/);
assert.match(tag, /release tag disappeared after validation/);
assert.match(tag, /release tag appeared after validation/);
assert.match(tag, /release tag object changed after validation/);

for (const build of [buildMac, buildLinux]) {
  assert.doesNotMatch(build, /secrets\./, 'build jobs cannot receive release credentials');
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /needs\.validate\.outputs\.tag/);
}

assert.match(buildMac, /CODESIGN_IDENTITY=-/);
assert.match(buildMac, /at least one resource bundle is required/);
assert.match(buildLinux, /defaults:\n\s+run:\n\s+shell: bash/);
assert.match(sign, /openssl pkcs12 -help.*grep -q -- '-legacy'/s);
assert.match(sign, /pkcs12_legacy=0/);
assert.match(sign, /pkcs12_legacy=1/);
assert.match(sign, /extract_pkcs12\(\)/);
assert.match(sign, /extract_pkcs12 .* -clcerts -nokeys/);
assert.match(sign, /extract_pkcs12 .* -nocerts -nodes/);
assert.doesNotMatch(sign, /security import "\$p12"/);
assert.match(sign, /security list-keychains -d user -s "\$keychain"/);
assert.match(sign, /security import "\$certificate"/);
assert.match(sign, /security import "\$private_key"/);
assert.match(sign, /arm64e arm64 x86_64|for arch in arm64e arm64 x86_64/);
assert.match(sign, /notarytool submit/);
assert.match(sign, /--check-notarization/);
assert.match(sign, /SIGNING-MANIFEST\.json/);
assert.match(sign, /ASSET-INVENTORY\.json/);

assert.doesNotMatch(verify, /secrets\./);
assert.match(verify, /permissions:\n      actions: read/);
assert.match(verify, /macos-15-intel/);
assert.match(verify, /macos-14/);
assert.match(verify, /arm64e arm64 x86_64/);
assert.match(verify, /ELF\.\*x86-64/);

assert.match(draft, /Check out frozen tag metadata/);
assert.match(draft, /persist-credentials: false/);
assert.match(draft, /ref: \$\{\{ needs\.validate\.outputs\.tag \}\}/);
assert.match(draft, /gh release create .* --verify-tag/);
assert.match(draft, /gh release view "\$TAG" --json databaseId/);

assert.match(publish, /github\.paginate\(github\.rest\.repos\.listReleaseAssets/);
assert.match(publish, /status >= 500 && status <= 599/);
assert.match(publish, /attempt === maxAttempts/);
assert.match(publish, /retrying in \$\{delayMs\}ms/);
assert.match(publish, /crypto\.createHash\('sha256'\)/);
assert.match(publish, /Authorization: Bearer \$GH_TOKEN/);
assert.equal(publish.match(/https:\/\/api\.github\.com\//g)?.length, publish.match(/Authorization: Bearer \$GH_TOKEN/g)?.length);

assert.match(handoff, /verified macOS Homebrew asset missing/);
assert.match(handoff, /request_id: requestId/);
assert.match(handoff, /Homebrew formula does not match verified release asset/);

console.log('Swift CLI workflow contract tests passed');
