#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realKeychains = process.argv.includes('--real-keychains');
if (realKeychains) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'native keychain tests require a disposable hosted runner');
}

const workflowPath = fileURLToPath(new URL('../.github/workflows/release-swift-cli.yml', import.meta.url));
const steps = JSON.parse(execFileSync('ruby', ['-rpsych', '-rjson', '-e', String.raw`
  workflow = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)
  puts JSON.generate(workflow.fetch('jobs').fetch('sign').fetch('steps'))
`, workflowPath], { encoding: 'utf8' }));
const signer = steps.find((step) => step.id === 'signer');
const cleanup = steps.find((step) => step.name === 'Restore signing keychain');
assert.equal(cleanup.if, 'always()');

const nativeSecurity = (args) => execFileSync('/usr/bin/security', args, { encoding: 'utf8' });
const parseKeychains = (text) => text.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
const hostKeychains = realKeychains ? parseKeychains(nativeSecurity(['list-keychains', '-d', 'user'])) : [];

const fixtureCommand = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (path.basename(process.argv[1]) === 'openssl') {
  if (args[0] === 'rand') console.log('test-keychain-password');
  else if (args.includes('-help')) console.log('fixture pkcs12 help');
  else fs.writeFileSync(args[args.indexOf('-out') + 1], 'fixture material');
  process.exit(0);
}
const statePath = path.join(process.env.RUNNER_TEMP, 'security-state.json');
const state = JSON.parse(fs.readFileSync(statePath));
const command = args[0];
const settingList = command === 'list-keychains' && args.includes('-s');
const failure = settingList ? (process.env.PHASE === 'cleanup' ? 'restore' : 'select') : command;
if (process.env.FAIL_SECURITY === failure) process.exit(1);
if (command === 'find-identity') {
  console.log('  1) ' + 'A'.repeat(40) + ' "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"');
} else if (command !== 'import' && command !== 'set-key-partition-list') {
  if (process.env.REAL_KEYCHAINS === '1') {
    const result = spawnSync('/usr/bin/security', args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
  if (command === 'list-keychains') {
    if (settingList) state.keychains = args.slice(args.indexOf('-s') + 1);
    else for (const keychain of state.keychains) console.log('    "' + keychain + '"');
  } else if (command === 'create-keychain') {
    const keychain = args.at(-1);
    fs.writeFileSync(keychain, 'empty fixture keychain');
    state.keychains.push(keychain);
  } else if (command === 'delete-keychain') {
    const keychain = args.at(-1);
    fs.rmSync(keychain);
    state.keychains = state.keychains.filter((item) => item !== keychain);
  } else if (!['unlock-keychain', 'set-keychain-settings'].includes(command)) {
    throw new Error('unexpected security command: ' + command);
  }
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

function runScenario(name, { empty = false, importFailure = '', cleanupFailure = '', skipImport = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swift-keychain-test-')));
  const keychain = path.join(root, 'swift-release.keychain-db');
  const original = empty ? [] : [path.join(root, 'login fixture.keychain-db'), path.join(root, 'other.keychain-db')];
  const statePath = path.join(root, 'security-state.json');
  const readSearchList = () => realKeychains
    ? parseKeychains(nativeSecurity(['list-keychains', '-d', 'user']))
    : JSON.parse(readFileSync(statePath)).keychains;
  try {
    if (realKeychains) {
      for (const item of original) nativeSecurity(['create-keychain', '-p', 'test-keychain-password', item]);
      nativeSecurity(['list-keychains', '-d', 'user', '-s', ...original]);
    }
    writeFileSync(statePath, JSON.stringify({ keychains: original }));
    // macOS can expose the login keychain after an empty search-list request.
    const expectedOriginal = readSearchList();
    if (!empty) assert.deepEqual(expectedOriginal, original, 'fixture search list must be installed');
    if (realKeychains && empty) console.log(`Native empty-list request exposes ${expectedOriginal.length} keychain(s) before signing`);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const command of ['security', 'openssl']) writeFileSync(path.join(bin, command), fixtureCommand, { mode: 0o755 });
    const output = path.join(root, 'output');
    writeFileSync(output, '');
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: output,
      P12_BASE64: Buffer.from('fixture material').toString('base64'),
      P12_PASSWORD: 'fixture-password',
      REPOSITORY_TYPE: 'openclaw',
      REAL_KEYCHAINS: realKeychains ? '1' : '0',
    };
    if (!skipImport) {
      const result = spawnSync('/bin/bash', ['-c', signer.run], {
        env: { ...env, PHASE: 'import', FAIL_SECURITY: importFailure }, encoding: 'utf8',
      });
      assert.equal(result.status, importFailure ? 1 : 0, `${name}: signer\n${result.stderr}`);
      if (!importFailure) assert.ok(readSearchList().includes(keychain), 'signing keychain must be searchable');
    }
    const exportedKeychain = readFileSync(output, 'utf8').match(/^keychain=(.*)$/m)?.[1] ?? '';
    const result = spawnSync('/bin/bash', ['-c', cleanup.run], {
      env: { ...env, KEYCHAIN: exportedKeychain, PHASE: 'cleanup', FAIL_SECURITY: cleanupFailure }, encoding: 'utf8',
    });
    assert.equal(result.status, cleanupFailure ? 1 : 0, `${name}: cleanup\n${result.stderr}`);
    if (cleanupFailure !== 'restore') assert.deepEqual(readSearchList(), expectedOriginal, `${name}: original search list must be restored`);
    if (cleanupFailure !== 'delete-keychain') assert.equal(existsSync(keychain), false, `${name}: ephemeral keychain must be deleted`);
    for (const file of ['swift-release.p12', 'swift-release-certificate.pem', 'swift-release-private-key.pem']) {
      assert.equal(existsSync(path.join(root, file)), false, `${name}: temporary material must be removed`);
    }
    console.log(`PASS ${name}${realKeychains ? ' (native macOS keychains)' : ''}`);
  } finally {
    if (realKeychains) {
      nativeSecurity(['list-keychains', '-d', 'user', '-s', ...hostKeychains]);
      for (const item of [keychain, ...original]) {
        if (existsSync(item)) nativeSecurity(['delete-keychain', item]);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

runScenario('successful signing restores ordered paths with spaces');
runScenario('empty original list works under Bash nounset', { empty: true });
runScenario('failed snapshot leaves original search list untouched', { importFailure: 'list-keychains' });
runScenario('failure just after creation still deletes keychain', { importFailure: 'set-keychain-settings' });
runScenario('failed certificate import cleans up without step outputs', { importFailure: 'import' });
runScenario('restoration failure does not skip keychain deletion', { cleanupFailure: 'restore' });
runScenario('deletion failure is reported after restoring search list', { cleanupFailure: 'delete-keychain' });
runScenario('skipped signer leaves host state untouched', { skipImport: true });
