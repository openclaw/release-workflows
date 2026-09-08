#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/release-electron.yml', import.meta.url)),
  'utf8',
);
const section = (start, end) => workflow.split(`\n  ${start}:\n`, 2)[1].split(`\n  ${end}:\n`, 1)[0];

for (const job of [
  'validate',
  'tag',
  'build-server',
  'build-desktop',
  'build-macos',
  'sign',
  'assemble',
  'draft',
  'verify',
  'publish',
  'closeout',
]) {
  assert.match(workflow, new RegExp(`^  ${job}:$`, 'm'), `missing job ${job}`);
}

const validate = section('validate', 'tag');
const tag = section('tag', 'build-server');
const server = section('build-server', 'build-desktop');
const desktop = section('build-desktop', 'build-macos');
const macos = section('build-macos', 'sign');
const sign = section('sign', 'assemble');
const assemble = section('assemble', 'draft');
const verify = section('verify', 'publish');
const publish = section('publish', 'closeout');

assert.match(validate, /Validate signing credentials/);
assert.match(validate, /missing required release secret\(s\)/);
assert.match(validate, /tag-object-sha/);
assert.match(tag, /EXPECTED_TAG_OBJECT/);

for (const unprivileged of [server, desktop, macos, verify]) {
  assert.doesNotMatch(unprivileged, /secrets\./, 'credential-free job references a release secret');
}
assert.match(server, /goreleaser\/goreleaser-action/);
assert.match(desktop, /--win nsis zip --x64/);
assert.match(desktop, /--linux AppImage deb --x64/);

assert.match(macos, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
assert.match(macos, /pnpm install --frozen-lockfile/);
assert.match(macos, /electron-builder --mac dir --x64 --arm64/);
assert.match(macos, /mac\.identity=null/);
assert.match(macos, /raw-electron-macos-\$\{\{ github\.run_id \}\}/);
assert.doesNotMatch(macos, /notarytool submit/);
assert.doesNotMatch(macos, /MACOS_SIGNING_P12/);

assert.match(sign, /needs: \[validate, build-macos\]/);
assert.match(sign, /permissions:\n      actions: read/);
assert.doesNotMatch(sign, /actions\/checkout@/);
assert.doesNotMatch(sign, /pnpm/);
assert.doesNotMatch(sign, /electron-builder/);
assert.doesNotMatch(sign, /release-artifacts\.mjs/);
assert.match(sign, /raw-electron-macos-\$\{\{ github\.run_id \}\}/);
for (const secret of [
  'MACOS_SIGNING_P12',
  'MACOS_SIGNING_P12_PASSWORD',
  'ASC_KEY_ID',
  'ASC_ISSUER_ID',
  'ASC_PRIVATE_KEY_P8',
]) {
  assert.match(sign, new RegExp(`secrets\\.${secret}`));
}
assert.match(sign, /notarytool submit/);
assert.match(sign, /stapler staple/);
assert.match(sign, /codesign --force/);
assert.match(sign, /hdiutil create/);
assert.match(sign, /ditto -c -k --sequesterRsrc --keepParent/);
assert.match(sign, /electron-desktop-mac-\$\{\{ github\.run_id \}\}/);

assert.match(assemble, /needs: \[validate, build-server, build-desktop, sign\]/);
assert.doesNotMatch(assemble, /raw-electron-macos/);

assert.match(verify, /macos-15-intel/);
assert.match(verify, /macos-14/);
assert.match(verify, /stapler validate/);
assert.match(verify, /\.AppImage/);
assert.match(verify, /PE32\|MS Windows/);
assert.match(publish, /listReleaseAssets/);
assert.match(publish, /status >= 500 && status <= 599/);
assert.match(publish, /attempt === maxAttempts/);
assert.match(publish, /retrying in \$\{delayMs\}ms/);
assert.match(publish, /crypto\.createHash\('sha256'\)/);
assert.match(publish, /draft asset inventory mismatch/);

console.log('Electron workflow contract tests passed');
