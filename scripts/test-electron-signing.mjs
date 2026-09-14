#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';

const nativePackaging = process.argv.includes('--native-packaging');
if (nativePackaging) assert.equal(process.platform, 'darwin');
const workflow = loadWorkflow('release-electron.yml');
const unpack = workflowStep(workflow, 'sign', 'name', 'Validate and unpack unsigned apps');
const signing = workflowStep(workflow, 'sign', 'name', 'Sign, notarize, staple, and package macOS apps');
assert.ok(workflow.jobs.sign.steps.indexOf(unpack) < workflow.jobs.sign.steps.findIndex((step) => step.id === 'signer'));
assert.doesNotMatch(JSON.stringify(unpack), /secrets\./);

const shim = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.RUNNER_TEMP;
const stateFile = path.join(root, 'signing-state.json');
const state = JSON.parse(fs.readFileSync(stateFile));
const target = args.at(-1);
const fail = (message) => { console.error(message); process.exit(1); };
const run = (program, argv) => {
  const result = spawnSync(program, argv, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (command === 'file') {
  console.log(fs.readFileSync(target, 'utf8').startsWith('MACHO') ? 'Mach-O 64-bit executable arm64' : 'ASCII text');
} else if (command === 'codesign') {
  if (args.includes('--verify')) {
    if (state.invalid.length) fail('nested seal invalidated: ' + state.invalid.join(', '));
    if (!state.signed.includes(target)) fail('unsigned app');
  } else {
    if (process.env.FAIL_PHASE === 'sign') fail('fixture signing failure');
    for (const signed of state.signed) if (target.startsWith(signed + '/')) state.invalid.push(signed);
    state.signed.push(target);
  }
} else if (command === 'ditto') {
  if (process.env.NATIVE_PACKAGING === '1') run('/usr/bin/ditto', args);
  else if (args.includes('-x')) {
    run('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', args.at(-2), target]);
  } else if (args.includes('-c')) {
    run('python3', ['-c', 'import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w"); [z.write(f,str(f.relative_to(p.parent))) for f in p.rglob("*") if f.is_file()]; z.close()', args.at(-2), target]);
  } else fs.cpSync(args[0], target, { recursive: true });
} else if (command === 'hdiutil') {
  if (process.env.NATIVE_PACKAGING === '1') run('/usr/bin/hdiutil', args);
  else fs.writeFileSync(target, 'fixture disk image');
} else if (command === 'xcrun') {
  if (args[0] === 'notarytool') {
    const submitted = args[2];
    if (!fs.existsSync(submitted)) fail('submission missing');
    if (submitted.endsWith('.dmg') && !state.signed.includes(submitted)) fail('unsigned DMG');
    const reject = process.env.FAIL_PHASE === (submitted.endsWith('.dmg') ? 'dmg-notary' : 'app-notary');
    if (!reject) state.accepted.push(submitted);
    console.log(JSON.stringify({ status: reject ? 'Rejected' : 'Accepted' }));
  } else if (args[0] === 'stapler') {
    const submitted = target.endsWith('.dmg') ? target : path.join(root, 'Fixture-' + target.split('/')[1] + '.zip');
    if (!state.accepted.includes(submitted)) fail('staple before accepted notarization: ' + submitted);
    if (args[1] === 'staple') state.stapled.push(target);
    else if (!state.stapled.includes(target)) fail('ticket missing');
  } else fail('unexpected xcrun command');
} else if (command !== 'spctl') fail('unexpected command: ' + command);
fs.writeFileSync(stateFile, JSON.stringify(state));
`;

const makeArchive = String.raw`
import pathlib, plistlib, stat, sys, zipfile
root, arch, scenario = sys.argv[1:]
product = 'Fixture.app'
base = product + '/Contents/'
entries = {
    base + 'Info.plist': plistlib.dumps({'CFBundleIdentifier': 'org.example.fixture', 'CFBundleExecutable': 'Fixture'}),
    base + 'MacOS/Fixture': b'MACHO main',
    base + 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework': b'MACHO framework',
    base + 'Frameworks/Electron Framework.framework/Versions/A/Helpers/Nested.app/Contents/MacOS/Nested': b'MACHO nested helper',
    base + 'XPCServices/Helper.xpc/Contents/MacOS/Helper': b'MACHO xpc',
    base + 'Resources/native.node': b'MACHO native extension without execute bit',
    base + 'Resources/afterSign.js': b'require("fs").writeFileSync("CALLER-RAN", "bad")',
}
links = {}
if scenario == 'parent': entries['../escaped'] = b'bad'
if scenario == 'absolute': entries[str(pathlib.Path(root) / 'escaped')] = b'bad'
if scenario == 'outside': links[base + 'Resources/link'] = '../../../../../escaped'
if scenario == 'absolute-link': links[base + 'Resources/link'] = str(pathlib.Path(root) / 'escaped')
if scenario == 'cycle':
    links[base + 'Resources/a'] = 'b'
    links[base + 'Resources/b'] = 'a'
if scenario == 'write-through-link':
    links[base + 'resources'] = 'MacOS'
    entries[base + 'Resources/new-file'] = b'bad'
if scenario == 'case-collision': entries[base + 'resources/NATIVE.node'] = b'bad'
if scenario == 'valid-links':
    framework = base + 'Frameworks/Electron Framework.framework/'
    links[framework + 'Versions/Current'] = 'A'
    links[framework + 'Electron Framework'] = 'Versions/Current/Electron Framework'
with zipfile.ZipFile(pathlib.Path(root) / 'raw-macos' / ('Fixture-' + arch + '.app.zip'), 'w') as archive:
    for name, data in entries.items():
        item = zipfile.ZipInfo(name); item.create_system = 3; item.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(item, data)
    for name, target in links.items():
        item = zipfile.ZipInfo(name); item.create_system = 3; item.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(item, target)
`;

function scenario(name, { archive = 'valid', failure = '', succeeds = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'electron-sign-test-')));
  try {
    const bin = path.join(root, 'bin');
    const runner = path.join(root, 'runner');
    mkdirSync(bin); mkdirSync(runner); mkdirSync(path.join(root, 'raw-macos'));
    for (const command of ['file', 'codesign', 'ditto', 'hdiutil', 'xcrun', 'spctl']) writeFileSync(path.join(bin, command), shim, { mode: 0o755 });
    writeFileSync(path.join(runner, 'signing-state.json'), JSON.stringify({ signed: [], invalid: [], accepted: [], stapled: [] }));
    for (const arch of ['x64', 'arm64']) execFileSync('python3', ['-c', makeArchive, root, arch, archive]);
    const env = {
      PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, PRODUCT_NAME: 'Fixture', VERSION: '1.2.3',
      BUNDLE_IDENTIFIER: 'org.example.fixture', TEAM_ID: 'FIXTURETEAM', IDENTITY: 'fixture-identity', KEYCHAIN: 'fixture-keychain',
      ASC_KEY_ID: 'fixture-key', ASC_ISSUER_ID: 'fixture-issuer', ASC_PRIVATE_KEY_P8: 'synthetic notary key',
      FAIL_PHASE: failure, NATIVE_PACKAGING: nativePackaging ? '1' : '0',
    };
    let result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', unpack.run], { cwd: root, env, encoding: 'utf8' });
    if (archive !== 'valid' && archive !== 'valid-links') {
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /ValueError:/);
      assert.ok(!existsSync(path.join(root, 'escaped')));
      console.log(`PASS Electron rejects ${name} before importing credentials`);
      return;
    }
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    // Exercise native PlistBuddy on macOS and substitute the fixture identifier on Linux.
    let source = signing.run;
    if (process.platform !== 'darwin') source = source.replaceAll('/usr/libexec/PlistBuddy', path.join(bin, 'plistbuddy'));
    writeFileSync(path.join(bin, 'plistbuddy'), '#!/bin/sh\nprintf "org.example.fixture\\n"\n', { mode: 0o755 });
    result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', source], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status === 0, succeeds, `${name}: ${result.stderr}\n${result.stdout}`);
    assert.ok(!existsSync(path.join(runner, 'electron-notary-key.p8')), 'notary key survives signing failure');
    assert.ok(!existsSync(path.join(root, 'CALLER-RAN')), 'caller hook executed');
    const state = JSON.parse(readFileSync(path.join(runner, 'signing-state.json')));
    if (succeeds) {
      assert.equal(state.accepted.length, 4, 'both apps and both DMGs must be notarized');
      assert.equal(state.invalid.length, 0);
      for (const arch of ['x64', 'arm64']) {
        const app = `unsigned/${arch}/Fixture.app`;
        for (const suffix of ['Contents/Resources/native.node', 'Contents/XPCServices/Helper.xpc', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/Nested.app']) {
          assert.ok(state.signed.includes(`${app}/${suffix}`), `missing nested signature: ${suffix}`);
        }
        assert.ok(!state.signed.some((item) => item.endsWith('afterSign.js')));
        for (const extension of ['zip', 'dmg']) assert.ok(existsSync(path.join(root, 'signed-macos', `Fixture-1.2.3-mac-${arch}.${extension}`)));
      }
      execFileSync('shasum', ['-a', '256', '-c', 'Fixture-1.2.3-mac-SHA256SUMS.txt'], { cwd: path.join(root, 'signed-macos') });
    }
    console.log(`PASS Electron ${name}${nativePackaging ? ' with native ditto/hdiutil' : ''}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

scenario('inside-out signing, separate DMG notarization, artifact names and checksums');
for (const archive of ['parent', 'absolute', 'outside', 'absolute-link', 'cycle', 'write-through-link', 'case-collision']) scenario(archive, { archive });
if (nativePackaging) scenario('versioned framework symlinks', { archive: 'valid-links' });
for (const failure of ['sign', 'app-notary', 'dmg-notary']) scenario(`${failure} failure cleans private key`, { failure, succeeds: false });
